export declare function stripMdFrontmatter(text: string): string;
export declare function cleanPageMarkdown(mdText: string): string;
export declare function extractMdLineRange(mdText: string, lineStart: number, lineEnd: number): string;
export declare function extractMarkdownRange(opts: {
    filesRoot: string;
    sourcePath: string;
    lineStart: number;
    lineEnd: number;
    onProgress?: (msg: string) => void;
}): Promise<[string, string, Record<string, unknown>]>;
export declare function extractPdfToMarkdown(opts: {
    filesRoot: string;
    sourcePath: string;
    pageStart: number;
    pageEnd: number;
    vlmModel?: string;
    vlmSystemPrompt?: string;
    onProgress?: (msg: string) => void;
}): Promise<[string, string, Record<string, unknown>]>;
export declare function mergeExtractStats(acc: Record<string, unknown>, stats: Record<string, unknown>): Record<string, unknown>;
