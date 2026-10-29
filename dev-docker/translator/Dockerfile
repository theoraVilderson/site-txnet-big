# The translator with its models built in (OPS-1-ai, ADR-0165, ADR-0166): it
# starts with no route out — a new server, staging, a national internet. Upstream
# downloads them on first start, and an empty volume never got ready.
ARG DOCKER_REGISTRY
FROM ${DOCKER_REGISTRY}/libretranslate/libretranslate:v1.6.2
# Which models load is deployment data (i18n contract §1.1), kept in this
# context so that adding a language changes the image's tag (R12) and rebuilds it.
COPY languages /app/languages
RUN ./venv/bin/python scripts/install_models.py --load_only_lang_codes "$(cat /app/languages)"
ENV LT_UPDATE_MODELS=false
ENTRYPOINT ["sh", "-c", "LT_LOAD_ONLY=\"$(cat /app/languages)\" exec ./venv/bin/libretranslate --host '*'"]
