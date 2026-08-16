# Embedded model runtimes

`llama-server` binaries live here, one directory per platform, named the way
`process.platform`-`process.arch` reports it:

```
resources/llm/darwin-arm64/llama-server
resources/llm/linux-x64/llama-server
resources/llm/win32-x64/llama-server.exe
```

They are **not committed**. A release build fetches them from a pinned
llama.cpp release before packaging; `electron-builder.yml` copies whatever is
here into the app's resources.

This directory being empty is a supported state, not a broken checkout.
`LlmEngine.available()` reports it, the AI settings say so, and every other
provider carries on working — which is why the app never assumes a runtime is
present.

Weights are never kept here. They are downloaded on first use into the user's
data directory, one copy serving every project; see `src/main/llm/modelStore.ts`
for why they are neither bundled nor stored in a project folder.
