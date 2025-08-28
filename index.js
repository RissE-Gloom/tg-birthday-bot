require('dotenv').config();
const { Telegraf, Markup } = require('telegraf');
const { createClient } = require('@supabase/supabase-js');
const { DateTime } = require('luxon');
const http = require('http');

// Конфигурация
const config = {
  botToken: process.env.TELEGRAM_BOT_TOKEN,
  supabaseUrl: process.env.SUPABASE_URL,
  supabaseKey: process.env.SUPABASE_KEY,
  timezone: process.env.TIMEZONE || 'Europe/Moscow',
  botUsername: process.env.BOT_USERNAME || 'lkworm_bot'
};

// Переменная для отслеживания последней проверки
let lastCheckDate = null;

// Проверка обязательных переменных
if (!config.botToken) {
  console.error('❌ Ошибка: TELEGRAM_BOT_TOKEN не установлен');
  process.exit(1);
}

// Инициализация клиентов
const supabase = createClient(config.supabaseUrl, config.supabaseKey);
const bot = new Telegraf(config.botToken);

// HTTP сервер для Health Check
const server = http.createServer(async (req, res) => {
  // Health check endpoint для Render и cron-job.org
  if (req.url === '/health' && req.method === 'GET') {
    const userAgent = req.headers['user-agent'] || '';
    const isCronJob = userAgent.includes('cron-job.org');
    
    if (isCronJob) {
      console.log('✅ Ping от cron-job.org - бот активен');
    }
    
    // 🔥 ОПТИМИЗАЦИЯ: Проверка дней рождений раз в сутки
    const today = DateTime.now().setZone(config.timezone).toISODate();
    if (lastCheckDate !== today) {
      console.log('🎂 Запуск ежедневной проверки дней рождений...');
      try {
        await checkBirthdays();
        lastCheckDate = today;
        console.log('✅ Проверка дней рождений завершена');
      } catch (error) {
        console.error('❌ Ошибка при проверке дней рождений:', error);
      }
    }
    
    res.writeHead(200, { 
      'Content-Type': 'application/json',
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET'
    });
    res.end(JSON.stringify({ 
      status: 'OK', 
      timestamp: new Date().toISOString(),
      service: 'Telegram Birthday Bot',
      timezone: config.timezone,
      lastCheckDate: lastCheckDate,
      visited: new Date().toLocaleString('ru-RU')
    }));
    return;
  }

  res.writeHead(404);
  res.end();
});

// ... (остальные функции: checkTableStructure, dateUtils, dbService остаются без изменений) ...

// Меню бота
function getMainMenu() {
  return Markup.keyboard([
    ['📅 Добавить дату', '👀 Список дней рождений'],
    ['ℹ️ Помощь']
  ])
  .resize()
  .oneTime();
}

function removeKeyboard() {
  return Markup.removeKeyboard();
}

function isBotMention(text) {
  return text.includes(`@${config.botUsername}`);
}

// 🔥 ОПТИМИЗАЦИЯ: Используем встроенные обработчики Telegraf

// Обработчик команды /start
bot.command('start', async (ctx) => {
  await checkTableStructure();
  return ctx.reply('Добро пожаловать! Используйте кнопки меню:', getMainMenu());
});

// Обработчик кнопки "Добавить дату"
bot.hears('📅 Добавить дату', (ctx) => {
  return ctx.reply(
    `Отправьте дату в формате ДД.ММ, например:\n\n@${config.botUsername} 15.09`,
    removeKeyboard()
  );
});

// Обработчик кнопки "Список дней рождений"
bot.hears('👀 Список дней рождений', async (ctx) => {
  try {
    const users = await dbService.getUsersByChat(ctx.chat.id);
    if (users.length === 0) {
      return ctx.reply('В этом чате пока нет сохраненных дат', getMainMenu());
    }
    
    const list = users.map(u => `• ${u.username ? '@' + u.username : 'Пользователь'}: ${u.birth_date}`).join('\n');
    return ctx.reply(`🎂 Дни рождения:\n${list}`, getMainMenu());
  } catch (error) {
    console.error('Ошибка:', error);
    return ctx.reply('❌ Ошибка при получении списка', getMainMenu());
  }
});

// Обработчик кнопки "Помощь"
bot.hears('ℹ️ Помощь', (ctx) => {
  return ctx.replyWithMarkdown(
    `*Как пользоваться ботом:*
1. Нажмите *"📅 Добавить дату"*
2. Отправьте \`@${config.botUsername} ДД.ММ\`
3. Используйте *"👀 Список дней рождений"* для просмотра

*Пример:*
\`@${config.botUsername} 15.09\` - сохранит дату 15 сентября.`,
    getMainMenu()
  );
});

// 🔥 ОПТИМИЗАЦИЯ: Отдельный обработчик для упоминаний с датами
bot.hears(new RegExp(`@${config.botUsername}\\s+[0-9.,]+`), async (ctx) => {
  const text = ctx.message.text.trim();
  const cleanText = text.replace(`@${config.botUsername}`, '').trim();
  
  try {
    const normalizedDate = dateUtils.normalizeDate(cleanText);
    
    if (!normalizedDate || !dateUtils.isValidDate(normalizedDate)) {
      return ctx.reply(
        '❌ Неверный формат! Используйте ДД.ММ. Пример:\n\n`@' + config.botUsername + ' 15.09`',
        getMainMenu()
      );
    }

    const username = ctx.from.username || null;
    await dbService.upsertUser(
      ctx.from.id,
      ctx.chat.id,
      username,
      normalizedDate
    );
    
    const replyText = username 
      ? `✅ Дата "${normalizedDate}" для @${username} сохранена!`
      : `✅ Дата "${normalizedDate}" сохранена!`;
    
    return ctx.reply(replyText, getMainMenu());
  } catch (error) {
    console.error('Ошибка:', error);
    return ctx.reply('❌ Ошибка при сохранении данных', getMainMenu());
  }
});

// 🔥 ОПТИМИЗАЦИЯ: Упрощенный обработчик текста (только для команд)
bot.on('text', async (ctx) => {
  // Теперь здесь обрабатываются только текстовые сообщения без упоминаний
  // Упоминания обрабатываются отдельным обработчиком выше
  console.log('Получено текстовое сообщение:', ctx.message.text);
});

// ... (функция checkBirthdays остается без изменений) ...

// Запуск бота с Polling (УПРОЩЕННЫЙ - без setInterval)
async function start() {
  console.log('🚀 Запуск бота...');
  console.log('📋 Проверка конфигурации...');
  
  await checkTableStructure();
  
  // 🔥 ОПТИМИЗАЦИЯ: Убрали setInterval - проверка теперь в /health
  console.log('✅ Проверка дней рождений будет запускаться через /health endpoint');

  // Запуск HTTP сервера для Health Check
  const port = process.env.PORT || 8000;
  server.listen(port, () => {
    console.log(`✅ HTTP сервер запущен на порту ${port}`);
    console.log(`✅ Health check: http://localhost:${port}/health`);
    console.log(`⏰ Настройте cron-job.org на вызов этого URL раз в сутки`);
  });

  // Запуск бота в режиме polling
  await bot.launch();
  console.log('✅ Бот запущен в режиме polling');
  console.log('✅ Бот готов к работе!');
}

// Обработка ошибок
bot.catch((err, ctx) => {
  console.error('Ошибка бота:', err);
  ctx.reply('⚠️ Произошла ошибка. Попробуйте позже', getMainMenu());
});

process.on('unhandledRejection', (err) => {
  console.error('Необработанная ошибка:', err);
});

// Запуск приложения
start().catch(err => {
  console.error('Ошибка запуска:', err);
  process.exit(1);
});
