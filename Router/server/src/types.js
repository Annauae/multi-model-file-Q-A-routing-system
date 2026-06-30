export function emptyTimings() {
    return {
        total_ms: 0,
        prepare_ms: 0,
        match_ms: 0,
        match_first_token_ms: 0,
        lookup_ms: 0,
        match_output_tokens: 0,
        tokens: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
        token_breakdown: [],
    };
}
