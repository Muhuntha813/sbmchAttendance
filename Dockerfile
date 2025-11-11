# ---- build stage ----
FROM node:20-alpine AS build
WORKDIR /app

# install build deps
COPY package*.json ./

# copy and build frontend
COPY frontend/ ./frontend/
WORKDIR /app/frontend
RUN npm ci --silent && npm run build

# ---- production stage ----
FROM node:20-slim AS prod
WORKDIR /app

# Create a non-root user for better security
RUN groupadd -r appgroup && useradd -r -g appgroup appuser || true

# Copy backend
COPY backend/ ./backend/
COPY package*.json ./

# Copy built frontend into backend's public folder (if backend serves static files)
# For now, we'll keep it in a separate location
COPY --from=build /app/frontend/dist ./frontend/dist

# Install only production deps
RUN npm ci --production --silent

ENV NODE_ENV=production
ENV PORT=3000

# Expose port
EXPOSE 3000

USER appuser

WORKDIR /app

# Use your start script
CMD ["npm", "run", "server"]
