require('dotenv').config();
const { Telegraf, Markup } = require('telegraf');
const admin = require('firebase-admin');
const { DateTime } = require('luxon');

// Конфигурация
const config = {
  botToken: process.env.TELEGRAM_BOT_TOKEN,
  firebaseDbUrl: process.env.FIREBASE_DB_URL,
  timezone: process.env.TIMEZONE || 'Europe/Moscow',
  botUsername: 'lkworm_bot'
};

// Инициализация Firebase
let serviceAccount;
const creds = process.env.FIREBASE_KEY_BASE64;

try {
  if (creds) {
    const trimmedCreds = creds.trim();
    if (trimmedCreds.startsWith('{')) {
      // Если это просто JSON (не зашифрованный в base64)
      serviceAccount = JSON.parse(trimmedCreds);
    } else {
      // Иначе пробуем декодировать как base64
      const decodedKey = Buffer.from(trimmedCreds, 'base64').toString('utf8');
      serviceAccount = JSON.parse(decodedKey);
    }
  } else {
    // Для локальной разработки: читаем из файла
    try {
      serviceAccount = require('./service-account.json');
    } catch (e) {
      console.log('⚠️ Файл service-account.json не найден и переменная FIREBASE_KEY_BASE64 пуста.');
    }
  }

  if (serviceAccount) {
    admin.initializeApp({
      credential: admin.credential.cert(serviceAccount),
      databaseURL: config.firebaseDbUrl
    });
    console.log('✅ Firebase успешно инициализирован');
  }
} catch (error) {
  console.error('❌ Критическая ошибка инициализации Firebase:', error.message);
  console.log('ℹ️ Проверьте формат ключа в переменной FIREBASE_KEY_BASE64');
}


const db = admin.database();
const bot = new Telegraf(config.botToken);

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
    if (!dateStr) return false;
    const [day, month] = dateStr.split('.').map(Number);
    if (month < 1 || month > 12) return false;
    if (day < 1 || day > 31) return false;

    const months30 = [4, 6, 9, 11];
    if (months30.includes(month) && day > 30) return false;
    if (month === 2 && day > 29) return false;

    return true;
  }
};

// Сервис работы с базой данных (Firebase Realtime Database)
const dbService = {
  upsertUser: async (userId, chatId, username, birthDate) => {
    const userRef = db.ref(`chats/${chatId}/${userId}`);
    await userRef.set({
      username: username || null,
      birth_date: birthDate,
      updated_at: admin.database.ServerValue.TIMESTAMP
    });
  },

  getUsersByChat: async (chatId) => {
    const snapshot = await db.ref(`chats/${chatId}`).once('value');
    const data = snapshot.val();
    if (!data) return [];

    return Object.entries(data).map(([userId, info]) => ({
      user_id: userId,
      ...info
    }));
  }
};

// Меню бота
function getMainMenu() {
  return Markup.keyboard([
    ['📅 Добавить дату', '👀 Список дней рождений'],
    ['ℹ️ Помощь']
  ])
    .resize()
    .oneTime();
}

// Проверка, содержит ли текст упоминание бота
function isBotMention(text) {
  return text.includes(`@${config.botUsername}`);
}

// Обработчики команд
bot.start((ctx) => {
  return ctx.reply('Добро пожаловать! Используйте кнопки меню:', getMainMenu());
});

bot.hears('📅 Добавить дату', (ctx) => {
  return ctx.reply(
    `Отправьте дату в формате ДД.ММ, например:\n\n@${config.botUsername} 15.09`,
    Markup.removeKeyboard()
  );
});

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

bot.hears('ℹ️ Помощь', (ctx) => {
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

bot.on('text', async (ctx) => {
  const text = ctx.message.text.trim();
  if (!isBotMention(text)) return;

  const cleanText = text.replace(`@${config.botUsername}`, '').trim();

  if (cleanText.startsWith('/start')) {
    return ctx.reply('Добро пожаловать! Используйте кнопки меню:', getMainMenu());
  }

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

// Проверка дней рождений
async function checkBirthdays() {
  const now = DateTime.now().setZone(config.timezone);
  const today = now.toFormat('dd.MM');
  const in7Days = now.plus({ days: 7 }).toFormat('dd.MM');

  try {
    const snapshot = await db.ref('chats').once('value');
    const allChats = snapshot.val();
    if (!allChats) return;

    for (const chatId in allChats) {
      const users = allChats[chatId];
      const todayCelebrations = [];
      const upcomingCelebrations = [];

      for (const userId in users) {
        const user = users[userId];
        if (user.birth_date === today) {
          todayCelebrations.push(user.username ? `@${user.username}` : `пользователя ${userId}`);
        } else if (user.birth_date === in7Days) {
          upcomingCelebrations.push(user.username ? `@${user.username}` : `пользователя ${userId}`);
        }
      }

      if (todayCelebrations.length > 0) {
        await bot.telegram.sendMessage(chatId, `🎉 Сегодня день рождения у ${todayCelebrations.join(', ')}! Поздравляем! 🎂`);
      }

      if (upcomingCelebrations.length > 0) {
        await bot.telegram.sendMessage(chatId, `⏳ Через неделю (${in7Days}) день рождения у ${upcomingCelebrations.join(', ')}! Не забудьте поздравить!`);
      }
    }
  } catch (error) {
    console.error('Ошибка проверки дней рождений:', error);
  }
}

// Запуск бота
async function start() {
  // Проверка при старте и каждые 24 часа
  if (admin.apps.length > 0) {
    await checkBirthdays();
    setInterval(checkBirthdays, 24 * 60 * 60 * 1000);
  }

  bot.launch();
  console.log('🚀 Бот успешно запущен');
}

bot.catch((err, ctx) => {
  console.error('Ошибка бота:', err);
  ctx.reply('⚠️ Произошла ошибка. Попробуйте позже', getMainMenu());
});

process.on('unhandledRejection', (err) => {
  console.error('Необработанная ошибка:', err);
});

start().catch(err => {
  console.error('Критическая ошибка запуска:', err);
  process.exit(1);
});
