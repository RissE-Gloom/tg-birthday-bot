require('dotenv').config();
const { Telegraf, Markup } = require('telegraf');
const admin = require('firebase-admin');
const { DateTime } = require('luxon');
const http = require('http');

// Очистка ключа от невидимых символов (BOM)
const cleanKey = (str) => str ? str.replace(/^\uFEFF/g, '').trim() : '';

// Конфигурация
const config = {
  botToken: cleanKey(process.env.TELEGRAM_BOT_TOKEN),
  firebaseDbUrl: cleanKey(process.env.FIREBASE_DB_URL),
  firebaseKeyBase64: cleanKey(process.env.FIREBASE_KEY_BASE64),
  timezone: process.env.TIMEZONE || 'Europe/Moscow',
  botUsername: process.env.BOT_USERNAME || 'birthdayotaky_bot'
};

// Проверка обязательных переменных
if (!config.botToken || !config.firebaseDbUrl || !config.firebaseKeyBase64) {
  console.error('❌ Ошибка: Не все переменные окружения установлены (TELEGRAM_BOT_TOKEN, FIREBASE_DB_URL, FIREBASE_KEY_BASE64)');
  process.exit(1);
}

// Инициализация Firebase
try {
  let serviceAccount;
  if (config.firebaseKeyBase64.startsWith('{')) {
    serviceAccount = JSON.parse(config.firebaseKeyBase64);
  } else {
    serviceAccount = JSON.parse(Buffer.from(config.firebaseKeyBase64, 'base64').toString('utf8'));
  }

  admin.initializeApp({
    credential: admin.credential.cert(serviceAccount),
    databaseURL: config.firebaseDbUrl
  });
  console.log('✅ Firebase инициализирован');
} catch (error) {
  console.error('❌ Ошибка инициализации Firebase:', error);
  process.exit(1);
}

const db = admin.database();
const bot = new Telegraf(config.botToken);

// Переменная для отслеживания последней проверки
let lastCheckDate = null;

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


// Утилиты для работы с датами
const dateUtils = {
  normalizeDate: (input) => {
    const cleaned = input.replace(/\D/g, '');
    if (cleaned.length === 3) {
      return `${cleaned[0].padStart(2, '0')}.${cleaned.slice(1).padStart(2, '0')}`;
    }
    if (cleaned.length === 4) {
      return `${cleaned.slice(0, 2)}.${cleaned.slice(2).padStart(2, '0')}`;
    }
    if (cleaned.length === 2) {
      return `${cleaned.padStart(2, '0')}.01`;
    }
    return null;
  },

  isValidDate: (dateStr) => {
    const [day, month] = dateStr.split('.').map(Number);
    if (month < 1 || month > 12) return false;
    if (day < 1 || day > 31) return false;

    const months30 = [4, 6, 9, 11];
    if (months30.includes(month) && day > 30) return false;
    if (month === 2 && day > 29) return false;

    return true;
  }
};

// Сервис работы с базой данных
const dbService = {
  upsertUser: async (userId, chatId, username, birthDate) => {
    try {
      await db.ref(`chats/${chatId}/${userId}`).set({
        user_id: userId,
        username: username || null,
        birth_date: birthDate,
        updated_at: new Date().toISOString()
      });
      return true;
    } catch (error) {
      console.error('Ошибка в upsertUser:', error);
      throw error;
    }
  },

  getUsersByChat: async (chatId) => {
    try {
      const snapshot = await db.ref(`chats/${chatId}`).once('value');
      const data = snapshot.val();
      if (!data) return [];

      // Конвертируем объект в массив и сортируем по времени обновления или ID для стабильности номера
      return Object.values(data).sort((a, b) => {
        return (a.user_id || 0).toString().localeCompare((b.user_id || 0).toString());
      });
    } catch (error) {
      console.error('Ошибка в getUsersByChat:', error);
      throw error;
    }
  }
};

// Хелпер для поиска профиля
async function handleProfileSearch(ctx, num) {
  try {
    const users = await dbService.getUsersByChat(ctx.chat.id);
    if (num > 0 && num <= users.length) {
      const user = users[num - 1];

      // Экранируем спецсимволы в нике для Markdown
      const safeUsername = user.username ? user.username.replace(/[_*`[\]()]/g, '\\$&') : null;

      const mention = safeUsername
        ? `@${safeUsername}`
        : `пользователь [профиль](tg://user?id=${user.user_id})`;

      return ctx.replyWithMarkdown(`👤 Профиль #${num}:\n${mention}`, getMainMenu());
    } else {
      return ctx.reply(`❌ Пользователь под номером ${num} не найден. В списке всего ${users.length} чел.`);
    }
  } catch (error) {
    console.error('Ошибка в handleProfileSearch:', error);
    return ctx.reply('❌ Ошибка при поиске профиля');
  }
}

// Обработка упоминания @bot /start в чатах
bot.hears(new RegExp(`@${config.botUsername}\\s+/start`), async (ctx) => {
  return ctx.reply('Добро пожаловать! Используйте кнопки меню:', getMainMenu());
});

// ЗАМЕНА: Inline Keyboard вместо обычной
function getMainMenu() {
  return Markup.inlineKeyboard([
    [
      Markup.button.callback('📅 Добавить дату', 'add_date'),
      Markup.button.callback('👀 Список дней рождений', 'view_birthdays')
    ],
    [
      Markup.button.callback('ℹ️ Помощь', 'show_help')
    ]
  ]);
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
  return ctx.reply('Добро пожаловать! Используйте кнопки меню:', getMainMenu());
});

// 🔥 ЗАМЕНА: Обработчики для inline кнопок
bot.action('add_date', (ctx) => {
  ctx.answerCbQuery();
  return ctx.reply(
    `Отправьте дату в формате ДД.ММ, например:\n\n@${config.botUsername} 15.09`,
    removeKeyboard()
  );
});

bot.action('view_birthdays', async (ctx) => {
  try {
    ctx.answerCbQuery();
    const users = await dbService.getUsersByChat(ctx.chat.id);
    if (users.length === 0) {
      return ctx.reply('В этом чате пока нет сохраненных дат', getMainMenu());
    }

    // Собираем нумерованный список без @
    const list = users.map((u, index) => `${index + 1}. ${u.username || 'Пользователь'} — ${u.birth_date}`).join('\n');

    const keyboard = Markup.inlineKeyboard([
      [Markup.button.callback('🔍 Узнать профиль', 'ask_profile_num')],
      [Markup.button.callback('⬅️ В меню', 'back_to_menu')]
    ]);

    return ctx.reply(`🎂 Дни рождения:\n${list}`, keyboard);
  } catch (error) {
    console.error('Ошибка:', error);
    return ctx.reply('❌ Ошибка при получении списка', getMainMenu());
  }
});

bot.action('ask_profile_num', (ctx) => {
  ctx.answerCbQuery();
  return ctx.reply('Напишите тег бота и введите номер пользователя из списка, чтобы получить ссылку на его профиль. Пример: @birthdayotaky_bot 1');
});

bot.action('back_to_menu', (ctx) => {
  ctx.answerCbQuery();
  return ctx.reply('Главное меню:', getMainMenu());
});

bot.action('show_help', (ctx) => {
  ctx.answerCbQuery();
  return ctx.replyWithMarkdown(
    `*Как пользоваться ботом:*
1. Нажмите *"📅 Добавить дату"*
2. Отправьте \`@${config.botUsername} ДД.ММ\`
3. Используйте *"👀 Список дней рождений"* для просмотра

*Пример:*
\`@${config.botUsername} 15.09\` - сохранит дату 15 сентября.

Важно! Если вы указали в лс бота свой день рождения, то бот поздравит именно через лс.
Если в чате добавляли день рождения, то поздравит в чате.`,
    getMainMenu()
  );
});

// 🔥 ОПТИМИЗАЦИЯ: Отдельный обработчик для упоминаний с датами (ищем формат ДД.ММ)
bot.hears(new RegExp(`@${config.botUsername}\\s+(\\d{1,2}[.\\/\\-]\\d{1,2})`), async (ctx) => {
  const text = ctx.match[1]; // Берем именно дату из захваченной группы

  try {
    const normalizedDate = dateUtils.normalizeDate(text);

    if (!normalizedDate || !dateUtils.isValidDate(normalizedDate)) {
      return ctx.reply(
        '❌ Неверный формат даты! Используйте ДД.ММ. Пример:\n\n`@' + config.botUsername + ' 15.09`',
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

// Обработчик для поиска профиля по номеру (поддерживает упоминание @bot номер)
bot.hears(new RegExp(`@${config.botUsername}\\s+(\\d+)`), async (ctx) => {
  const num = parseInt(ctx.match[1], 10);
  return handleProfileSearch(ctx, num);
});

// 🔥 ОПТИМИЗАЦИЯ: Упрощенный обработчик текста (обработка чисел и команд)
bot.on('text', async (ctx) => {
  const text = ctx.message.text.trim();

  // Если введено число — ищем профиль из списка
  if (/^\d+$/.test(text)) {
    const num = parseInt(text, 10);
    try {
      const users = await dbService.getUsersByChat(ctx.chat.id);
      if (num > 0 && num <= users.length) {
        const user = users[num - 1];
        const mention = user.username
          ? `@${user.username}`
          : `пользователь [link](tg://user?id=${user.user_id})`;

        return ctx.replyWithMarkdown(`👤 Профиль #${num}:\n${mention}`, getMainMenu());
      }
    } catch (error) {
      console.error('Ошибка при поиске профиля:', error);
    }
  }

  // Упоминания бота с датами обрабатываются выше через bot.hears(RegExp)
  // Здесь можно логировать или игнорировать остальные сообщения
  console.log('Получено сообщение:', text);
});

// Проверка дней рождений с обработкой ошибок
async function checkBirthdays() {
  const now = DateTime.now().setZone(config.timezone);
  const today = now.toFormat('dd.MM');
  const in7Days = now.plus({ days: 7 }).toFormat('dd.MM');

  try {
    const snapshot = await db.ref('chats').once('value');
    const chats = snapshot.val();
    if (!chats) return;

    for (const chatId in chats) {
      const users = Object.values(chats[chatId]);
      const todayCelebrations = users.filter(user => user.birth_date === today);
      const upcomingCelebrations = users.filter(user => user.birth_date === in7Days);

      // Отправка уведомлений на сегодня
      if (todayCelebrations.length > 0) {
        try {
          const mentions = todayCelebrations.map(u =>
            u.username ? `@${u.username}` : `пользователя ${u.user_id}`
          ).join(', ');
          await bot.telegram.sendMessage(chatId, `🎉 Сегодня день рождения у ${mentions}! Поздравляем! 🎂`);
        } catch (error) {
          if (error.response && (error.response.error_code === 403 || error.response.error_code === 400)) {
            console.log(`❌ Ошибка доступа к чату ${chatId}, пропускаем...`);
          } else {
            console.error('Ошибка отправки сообщения (сегодня):', error);
          }
        }
      }

      // Уведомления за 7 дней
      if (upcomingCelebrations.length > 0) {
        try {
          const mentions = upcomingCelebrations.map(u =>
            u.username ? `@${u.username}` : `пользователя ${u.user_id}`
          ).join(', ');
          await bot.telegram.sendMessage(
            chatId,
            `⏳ Через неделю (${in7Days}) день рождения у ${mentions}! Не забудьте поздравить!`
          );
        } catch (error) {
          if (error.response && (error.response.error_code === 403 || error.response.error_code === 400)) {
            console.log(`❌ Ошибка доступа к чату ${chatId}, пропускаем...`);
          } else {
            console.error('Ошибка отправки сообщения (через неделю):', error);
          }
        }
      }
    }
  } catch (error) {
    console.error('Ошибка в checkBirthdays:', error);
  }
}

// Запуск бота с Polling
async function start() {
  console.log('🚀 Запуск бота...');
  console.log('📋 Проверка конфигурации:');
  console.log('BOT_TOKEN:', config.botToken ? '✅ Установлен' : '❌ Отсутствует');
  console.log('FIREBASE_DB_URL:', config.firebaseDbUrl ? '✅ Установлен' : '❌ Отсутствует');
  console.log('TIMEZONE:', config.timezone);

  // 🔥 ОПТИМИЗАЦИЯ: Убрали setInterval - проверка теперь в /health
  console.log('✅ Проверка дней рождений будет запускаться через /health endpoint');

  // Запуск HTTP сервера для Health Check
  const port = process.env.PORT || 8000;
  server.listen(port, '0.0.0.0', () => {
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


