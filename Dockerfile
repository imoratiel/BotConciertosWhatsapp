# Imagen oficial de puppeteer — Chrome preinstalado, deps de sistema resueltos,
# usuario no-root (pptruser) y PUPPETEER_EXECUTABLE_PATH ya configurado.
FROM ghcr.io/puppeteer/puppeteer:22

# No descargar Chrome extra al hacer npm ci:
# usamos el Chrome que ya viene en esta imagen (apuntado por PUPPETEER_EXECUTABLE_PATH).
ENV PUPPETEER_SKIP_CHROMIUM_DOWNLOAD=true

WORKDIR /home/pptruser/app

# Instalamos dependencias como pptruser (el usuario del contenedor)
COPY --chown=pptruser:pptruser package*.json ./
RUN npm install --omit=dev --no-fund --no-audit --fetch-timeout=300000 --fetch-retry-mintimeout=20000 --fetch-retries=5

COPY --chown=pptruser:pptruser index.js auth.js entrypoint.sh ./

# Directorio de sesión (sobreescrito por el volumen en docker-compose)
RUN mkdir -p /home/pptruser/app/.wwebjs_auth

# Normalizar saltos de línea (CRLF→LF) y dar permiso de ejecución
RUN sed -i 's/\r//' /home/pptruser/app/entrypoint.sh && \
    chmod +x /home/pptruser/app/entrypoint.sh

ENTRYPOINT ["/home/pptruser/app/entrypoint.sh"]
