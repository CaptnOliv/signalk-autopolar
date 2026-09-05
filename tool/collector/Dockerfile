FROM node:22-alpine
WORKDIR /app
COPY server.js .
ENV POLARS_DIR=/data PORT=8080
VOLUME /data
CMD ["node", "server.js"]
