// Reads settings from environment variables. Fails fast on bad config.

const token = process.env.API_TOKEN ?? '';
if (token.trim() === '') {
  // An empty token would let "Authorization: Bearer " through.
  throw new Error('API_TOKEN must be set to a non-empty value');
}

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) {
  throw new Error('DATABASE_URL must be set');
}

export const config = {
  token,
  databaseUrl,
  port: Number(process.env.PORT ?? 8080),
};
