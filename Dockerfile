FROM node:22-alpine
WORKDIR /srv/vibloo
COPY server/package.json server/package-lock.json ./
RUN npm ci --omit=dev
COPY server/src ./src
COPY server/public ./public
ENV NODE_ENV=production PORT=3000 DB_FILE=/data/vibloo.db
RUN mkdir -p /data
VOLUME /data
EXPOSE 3000
CMD ["node", "--disable-warning=ExperimentalWarning", "src/index.js"]
