FROM node:20-alpine
WORKDIR /app
COPY web/package*.json web/
RUN cd web && npm install --omit=dev
COPY shared/ shared/
COPY artifacts/exemplars.json artifacts/thresholds.json artifacts/
COPY web/ web/
EXPOSE 2000
WORKDIR /app/web
CMD ["npm", "start"]
