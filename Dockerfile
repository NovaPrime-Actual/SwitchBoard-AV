# SPDX-License-Identifier: AGPL-3.0-or-later
#
# SwitchBoard-AV as a container image. The app has no dependencies and no build step, so this just puts the
# program files in a small Node image. Everything the app saves (accounts, groups, the device list, activity,
# the self-signed certificate) goes in /data: mount a volume there or it is lost when the container is removed.
#
#   docker run -d --name switchboard-av --restart unless-stopped -p 8080:8080 -v switchboard-data:/data \
#     ghcr.io/novaprime-actual/switchboard-av:latest
#
# The README ("Run it with Docker") has the details. The Node version matches .nvmrc.

FROM node:24-alpine

ENV NODE_ENV=production \
    DATA_DIR=/data

WORKDIR /app

COPY package.json server.js devices.json LICENSE NOTICE ./
COPY src ./src
COPY public ./public

# the app runs as the unprivileged "node" user that the Node image provides
RUN mkdir -p /data && chown node:node /data
USER node
VOLUME /data
EXPOSE 8080

# The front page answers without signing in. Tries https first (the default, with a self-signed certificate
# that is not checked here), then plain http for TLS=off or TRUST_PROXY=1.
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD node -e "const p=process.env.PORT||8080,go=(m,o)=>new Promise((ok,no)=>require(m).get(o,r=>ok(r.statusCode)).on('error',no));go('https',{host:'127.0.0.1',port:p,rejectUnauthorized:false}).catch(()=>go('http',{host:'127.0.0.1',port:p})).then(c=>process.exit(c<500?0:1),()=>process.exit(1))"

CMD ["node", "server.js"]
