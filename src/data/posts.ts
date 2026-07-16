type PostModule = {
    frontmatter: {
        title?: string;
        date?: string;
        author?: string;
    };
    url?: string;
};

const modules = import.meta.glob<PostModule>("../pages/posts/*.md", { eager: true });

export const posts = Object.entries(modules)
    .map(([path, module]) => ({
        title: module.frontmatter.title ?? path.split("/").pop() ?? path,
        date: module.frontmatter.date ?? "",
        url: module.url ?? path.replace("../pages", "").replace(/\.md$/, "/"),
        author: module.frontmatter.author
    }))
    .sort((a, b) => b.date.localeCompare(a.date));
