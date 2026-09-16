#!/usr/bin/env bash
# Loads a GGUF model file into the running translator-llm (Ollama) container
# under the name billing asks for — for a server with no route to ollama.com
# (offline, national internet, or a network that blocks its blob store).
# ADR-0050 amendment 3.
#
#   scripts/translator-llm-import.sh <file.gguf> [model name] [container]
#
# The file for the default model, qwen2.5:3b (~2 GB), downloaded anywhere:
#   https://huggingface.co/Qwen/Qwen2.5-3B-Instruct-GGUF/resolve/main/qwen2.5-3b-instruct-q4_k_m.gguf
# Ollama reads the chat template from the file itself. Once imported the model
# lives in the container's volume and survives restarts.
set -euo pipefail

GGUF="${1:?usage: $0 <file.gguf> [model name] [container]}"
MODEL="${2:-${TRANSLATOR_LLM_MODEL:-qwen2.5:3b}}"
CONTAINER="${3:-${STACK_NAME:-txnet-dev}-translator-llm}"

[ -f "$GGUF" ] || { echo "no such file: $GGUF" >&2; exit 1; }

docker exec "$CONTAINER" mkdir -p /root/.ollama/import
docker cp "$GGUF" "$CONTAINER:/root/.ollama/import/model.gguf"
docker exec "$CONTAINER" sh -c "printf 'FROM /root/.ollama/import/model.gguf\nPARAMETER temperature 0\n' > /root/.ollama/import/Modelfile \
  && ollama create '$MODEL' -f /root/.ollama/import/Modelfile \
  && rm -f /root/.ollama/import/model.gguf"
docker exec "$CONTAINER" ollama list
