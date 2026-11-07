FROM node:22-alpine
WORKDIR /app
COPY package*.json ./
RUN npm ci --omit=dev
COPY server ./server
COPY public ./public
COPY docs ./docs
RUN mkdir -p data uploads
ENV PORT=3000
EXPOSE 3000
CMD ["node", "server/index.js"]
