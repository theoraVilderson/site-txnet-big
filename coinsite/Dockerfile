# ---------- Base ----------
FROM node:22 AS base
WORKDIR /app
COPY package*.json ./
RUN npm install

# ---------- Development ----------
FROM base AS dev
ENV NODE_ENV=development
COPY . .
EXPOSE 8080
CMD ["npm", "run", "dev"]

# ---------- Production ----------
FROM base AS prod
ENV NODE_ENV=production
COPY . .
RUN npm run build
EXPOSE 80
CMD ["npm", "start"]
