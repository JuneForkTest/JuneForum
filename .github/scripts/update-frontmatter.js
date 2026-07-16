const fs = require('fs');
const path = require('path');
const yaml = require('js-yaml');
const { execSync } = require('child_process');

// ============== 环境变量 ==============
const prAuthorId = process.env.PR_AUTHOR_ID;
if (!prAuthorId) {
  console.error('PR_AUTHOR_ID environment variable not set');
  process.exit(1);
}

const baseRef = process.env.GITHUB_BASE_REF;
if (!baseRef) {
  console.error('GITHUB_BASE_REF environment variable not set');
  process.exit(1);
}

// ---------- 日期：北京时间 (Asia/Shanghai) ----------
const dateFormatter = new Intl.DateTimeFormat('zh-CN', {
  timeZone: 'Asia/Shanghai',
  year: 'numeric',
  month: '2-digit',
  day: '2-digit'
});
const parts = dateFormatter.formatToParts(new Date());
const year = parts.find(p => p.type === 'year').value;
const month = parts.find(p => p.type === 'month').value;
const day = parts.find(p => p.type === 'day').value;
const today = `${year}-${month}-${day}`;

const DELIMITER = '---';
const TARGET_DIR = 'src/pages/post/';   // 目标目录（相对于仓库根目录）

// ============== 工具函数 ==============

/** 提取 YAML frontmatter 内容（不含分隔符） */
function extractFrontmatter(content) {
  const lines = content.split(/\r?\n/);
  if (lines.length < 2) return null;
  if (lines[0].trim() !== DELIMITER) return null;
  const yamlLines = [];
  let foundEnd = false;
  for (let i = 1; i < lines.length; i++) {
    const line = lines[i];
    if (line.trim() === DELIMITER) {
      foundEnd = true;
      break;
    }
    yamlLines.push(line);
  }
  if (!foundEnd) return null;
  return yamlLines.join('\n');
}

/** 获取 base 分支中指定文件的内容 */
function getFileContentAtBase(filePath) {
  try {
    const cmd = `git show origin/${baseRef}:${filePath}`;
    const content = execSync(cmd, { encoding: 'utf8', stdio: 'pipe' });
    return content;
  } catch (e) {
    console.error(`Failed to get base content for ${filePath}: ${e.message}`);
    return null;
  }
}

/** 从文件内容解析 author 字段 */
function getAuthorFromContent(content) {
  const yamlRaw = extractFrontmatter(content);
  if (!yamlRaw) return null;
  try {
    const parsed = yaml.load(yamlRaw);
    if (typeof parsed === 'object' && parsed !== null) {
      return parsed.author;
    }
  } catch (e) {
    // ignore
  }
  return null;
}

/** 获取本次 PR 中变更的 .md 文件列表（含状态） */
function getChangedMarkdownFiles() {
  const diffCmd = `git diff --name-status --diff-filter=AMD origin/${baseRef}...HEAD -- '*.md'`;
  let output;
  try {
    output = execSync(diffCmd, { encoding: 'utf8' });
  } catch (e) {
    console.error('Failed to get diff files');
    process.exit(1);
  }
  const files = output.split('\n').filter(line => line.trim() !== '');
  const result = [];
  for (const line of files) {
    const parts = line.split('\t');
    if (parts.length < 2) continue;
    const status = parts[0];
    const filePath = parts[1];
    result.push({ status, filePath });
  }
  return result;
}

/** 判断文件是否在目标目录下（包括子目录） */
function isInTargetDir(filePath) {
  return filePath.startsWith(TARGET_DIR);
}

/** 
 * 检查所有目标目录中修改/删除文件的 base author 是否匹配当前 PR 作者
 * 返回 { allMatch, mismatched }
 */
function checkTargetAuthorsMatch(changedFiles, prAuthorId) {
  let allMatch = true;
  const mismatched = [];

  for (const { status, filePath } of changedFiles) {
    if (!isInTargetDir(filePath)) continue;   // 非目标文件不参与 author 检查
    if (status === 'A') continue;             // 新增文件无需检查 base

    const content = getFileContentAtBase(filePath);
    if (content === null) {
      console.warn(`Cannot get base content for ${filePath}, treating as mismatch.`);
      allMatch = false;
      mismatched.push(filePath);
      continue;
    }

    const author = getAuthorFromContent(content);
    if (author === null) {
      console.warn(`No author field found in base version of ${filePath}, treating as mismatch.`);
      allMatch = false;
      mismatched.push(filePath);
    } else if (String(author) !== String(prAuthorId)) {
      console.warn(`Author mismatch for ${filePath}: base author = ${author}, expected ${prAuthorId}`);
      allMatch = false;
      mismatched.push(filePath);
    }
  }

  return { allMatch, mismatched };
}

/** 
 * 更新文件（仅对目标目录中的 A 和 M 有效，跳过 D）
 * 覆写 author 和 date
 */
function updateFile(filePath, prAuthorId, today) {
  if (!isInTargetDir(filePath)) return false;

  const fullPath = path.join(process.cwd(), filePath);
  if (!fs.existsSync(fullPath)) {
    console.warn(`File ${filePath} does not exist (maybe deleted), skipping update.`);
    return false;
  }

  const content = fs.readFileSync(fullPath, 'utf8');
  const yamlRaw = extractFrontmatter(content);
  if (!yamlRaw) {
    console.log(`No YAML frontmatter in ${filePath}, skipping update.`);
    return false;
  }

  let parsed;
  try {
    parsed = yaml.load(yamlRaw);
  } catch (e) {
    console.error(`Invalid YAML in ${filePath}: ${e.message}`);
    return false;
  }

  if (typeof parsed !== 'object' || parsed === null) {
    console.warn(`Parsed frontmatter not object in ${filePath}`);
    return false;
  }

  let needsUpdate = false;
  if (parsed.author !== String(prAuthorId)) {
    parsed.author = String(prAuthorId);
    needsUpdate = true;
  }
  if (parsed.date !== today) {
    parsed.date = today;
    needsUpdate = true;
  }

  if (!needsUpdate) {
    console.log(`No changes needed for ${filePath}`);
    return true;
  }

  // 重新构建 frontmatter
  const yamlStr = yaml.dump(parsed, {
    lineWidth: -1,
    noRefs: true,
    quotingType: '"',
  }).trim();
  const newFrontmatter = `${DELIMITER}\n${yamlStr}\n${DELIMITER}`;

  // 替换原有的 frontmatter
  const firstIdx = content.indexOf(DELIMITER);
  const secondIdx = content.indexOf(DELIMITER, firstIdx + DELIMITER.length);
  if (firstIdx === -1 || secondIdx === -1) return false;
  const before = content.substring(0, firstIdx);
  const after = content.substring(secondIdx + DELIMITER.length);
  const newContent = before + newFrontmatter + after;

  fs.writeFileSync(fullPath, newContent, 'utf8');
  console.log(`Updated ${filePath}: author -> ${prAuthorId}, date -> ${today}`);
  return true;
}

// ============== 主入口 ==============

function main() {
  const changedFiles = getChangedMarkdownFiles();
  if (changedFiles.length === 0) {
    console.log('No markdown files changed.');
    fs.writeFileSync('.github/scripts/check_result.txt', 'PASS');
    process.exit(0);
  }

  // ---- 1. 检查是否所有变更的 .md 文件都在目标目录内 ----
  const outOfScope = changedFiles.filter(f => !isInTargetDir(f.filePath));
  let allInScope = (outOfScope.length === 0);

  if (!allInScope) {
    console.warn(`Found .md files outside ${TARGET_DIR}:`);
    outOfScope.forEach(f => console.warn(`  ${f.filePath} (${f.status})`));
  }

  // ---- 2. 检查目标目录中 M/D 文件的 base author ----
  const { allMatch, mismatched } = checkTargetAuthorsMatch(changedFiles, prAuthorId);
  console.log(`Author check result for target files: ${allMatch ? 'PASSED' : 'FAILED'}`);
  if (!allMatch) {
    console.log(`Mismatched files: ${mismatched.join(', ')}`);
  }

  // ---- 3. 更新目标目录中的 A 和 M 文件 ----
  let updatedAny = false;
  for (const { status, filePath } of changedFiles) {
    if (status === 'D') continue;
    const ok = updateFile(filePath, prAuthorId, today);
    if (ok) updatedAny = true;
  }

  // ---- 4. 综合判定：必须同时满足“所有文件在目标目录”且“author 检查全部通过” ----
  const finalPass = allInScope && allMatch;

  // 写入结果文件
  fs.writeFileSync('.github/scripts/check_result.txt', finalPass ? 'PASS' : 'FAIL');
  console.log(`Final check result: ${finalPass ? 'PASS' : 'FAIL'}`);
}

main();