FROM node:24-alpine
WORKDIR /app
COPY package*.json ./
RUN npm ci --omit=dev --ignore-scripts
COPY server ./server
COPY src ./src
COPY public ./public
COPY data/examples ./data/examples
USER node
ENV PORT=8080 STORE=firestore
EXPOSE 8080
CMD ["node", "server/index.js"]
