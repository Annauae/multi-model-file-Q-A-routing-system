export declare const APP_ROOT: string;
export interface Settings {
    apiBaseUrl: string;
    apiKey: string;
    matchModel: string;
    importModel: string;
    maxTokens: number;
    matchMaxTokens: number;
    confidenceMaxTokens: number;
    confidenceTopK: number;
    matchTemperature: number;
    useMaxCompletionTokens: boolean;
    mockLlm: boolean;
    useContentParts: boolean;
    enableThinking: boolean | null;
    reasoningEffort: string | null;
    dataRoot: string;
    kbConfigPath: string;
    filesRoot: string;
    debugRequestTimeoutS: number;
}
export declare function loadSettings(): Settings;
