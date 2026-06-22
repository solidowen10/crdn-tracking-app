module.exports = {
  apps: [
    {
      name: 'crdn-tracking-app',
      script: './server.js',
      instances: 1,
      exec_mode: 'fork',
      watch: false,
      max_memory_restart: '300M',
      env: {
        NODE_ENV: 'production',
        TELEGRAM_BOT_TOKEN: process.env.TELEGRAM_BOT_TOKEN,
	TELEGRAM_WEBHOOK_SECRET: "AJEI21399943Sjk33isjaSUEH984JSKN",
	APP_BASE_URL: "https://tool.creativeden.studio",
	TELEGRAM_ALLOWED_CHAT_IDS: "-5172693565"
      }
    }
  ]
};
