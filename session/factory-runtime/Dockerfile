ARG BASE_IMAGE
FROM ${BASE_IMAGE}
RUN apt-get update \
    && apt-get install --yes --no-install-recommends ca-certificates curl docker.io git jq python3 sudo util-linux \
    && rm -rf /var/lib/apt/lists/*
COPY session /opt/agent-sandbox/session
COPY lib /opt/agent-sandbox/lib
ENV HOME=/opt/factory-tools
RUN /opt/agent-sandbox/session/bootstrap --factory-tools
ENV POTS_TOOLCHAIN=/opt/factory-tools/.local
ENV PATH=/opt/factory-tools/.local/bin:/usr/local/bin:/usr/bin:/bin
ENV HOME=/config
ENTRYPOINT ["/usr/bin/python3", "-I", "/opt/agent-sandbox/session/factory-runtime/start.py"]
