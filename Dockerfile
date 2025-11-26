# Nextcloud Text App Docker Image for jobnik-cloud
# Multi-stage build: build frontend assets, then create minimal runtime image

# Stage 1: Build frontend assets
FROM node:24-alpine AS builder

WORKDIR /build

# Copy package files first for better caching
COPY package.json package-lock.json ./

# Install dependencies
RUN npm ci

# Copy source files
COPY . .

# Build the app
RUN npm run build

# Stage 2: Runtime image with only necessary files
FROM alpine:3.20 AS runtime

# Create app directory structure
WORKDIR /app

# Copy only the files needed at runtime from the build stage and source
# appinfo - app metadata and routes
COPY --from=builder /build/appinfo ./appinfo/

# lib - PHP backend code
COPY --from=builder /build/lib ./lib/

# js - built JavaScript (from build)
COPY --from=builder /build/js ./js/

# css - built CSS (from build)
COPY --from=builder /build/css ./css/

# l10n - translations
COPY --from=builder /build/l10n ./l10n/

# img - images and icons
COPY --from=builder /build/img ./img/

# templates - PHP templates
COPY --from=builder /build/templates ./templates/

# composer - PHP autoloader and dependencies
COPY --from=builder /build/composer ./composer/

# Set proper permissions
RUN chown -R 33:33 /app

# This image is used as a source for initContainers
# The initContainer will copy /app/* to the target volume
CMD ["echo", "Text app files ready for copying"]

