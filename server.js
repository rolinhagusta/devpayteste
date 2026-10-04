// Só para rodar LOCAL (npm start). No Vercel quem responde é api/index.js
const app = require('./app');
const port = process.env.PORT || 3000;
app.listen(port, () => console.log(`DEV PAY rodando em http://localhost:${port}`));
