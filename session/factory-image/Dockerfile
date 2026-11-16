FROM node:24.22.3-bookworm-slim
RUN apt-get update \
	&& apt-get install --yes --no-install-recommends git jq python3 shellcheck \
	&& rm -rf /var/lib/apt/lists/* \
	&& npm install --global --no-fund --no-audit fallow@3.43.1 pnpm@12.18.0 @earendil-works/pi-coding-agent@1.4.0
USER node
