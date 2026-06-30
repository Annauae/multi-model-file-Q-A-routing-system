export declare function buildMarkdownFilesTree(filesRoot: string): {
    tree: {
        type: string;
        name: string;
        children: unknown[];
    }[];
};
export declare function resolveDocumentPath(filesRoot: string, relPath: string): [string, string];
export declare function readMarkdownContent(filesRoot: string, relPath: string): {
    path: string;
    kind: string;
    markdown: string;
    line_count: number;
    size: number;
};
export declare function saveMarkdownContent(filesRoot: string, relPath: string, markdown: string): {
    path: string;
    kind: string;
    line_count: number;
    size: number;
};
export declare function deleteDocumentFile(filesRoot: string, relPath: string): {
    path: string;
    kind: string;
    deleted: boolean;
};
export declare function renameDocumentFile(filesRoot: string, relPath: string, newName: string): {
    old_path: string;
    type: string;
    name: string;
    path: string;
    kind: string;
    size: number;
    line_count: number;
    updated_at: string;
};
export declare function createModuleMarkdown(filesRoot: string, name: string, markdown?: string): {
    path: string;
    kind: string;
    line_count: number;
    size: number;
};
export declare function documentsSourcePath(filesRoot: string, filename: string): string;
