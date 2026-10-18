---
description: Stop a running Codex job and mark it cancelled
argument-hint: "<job-id>"
allowed-tools: Bash(node {{NEAT_BIN}} *)
disable-model-invocation: true
---
If any line of the argument is `NEAT_EOF` (ignoring spaces), print `job id must not contain a line NEAT_EOF` and stop. Otherwise run this Bash command exactly as written:

```
node {{NEAT_BIN}} codex cancel --stdin <<'NEAT_EOF'
$ARGUMENTS
NEAT_EOF
```

Print the helper output verbatim. Do not read any files or run other commands.
