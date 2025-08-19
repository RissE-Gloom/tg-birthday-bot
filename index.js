require('dotenv').config();
const { Telegraf, Markup } = require('telegraf');
const { createClient } = require('@supabase/supabase-js');
const { DateTime } = require('luxon');

// Конфигурация
const config = {
  botToken: process.env.TELEGRAM_BOT_TOKEN,
  supabaseUrl: process.env.SUPABASE_URL,
  supabaseKey: process.env.SUPABASE_KEY,
  timezone: process.env.TIMEZONE || 'Europe/Moscow',
  botUsername: 'lkworm_bot' // Жестко задаем имя бота
};

// Инициализация клиентов
const supabase = createClient(config.supabaseUrl, config.supabaseKey);
const bot = new Telegraf(config.botToken);

// Проверка структуры таблицы
async function checkTableStructure() {
  const { error } = await supabase
    .from('chat_members')
    .select('user_id, chat_id, username, birth_date')
    .limit(1);

  if (error) {
    console.error('❌ Ошибка структуры таблицы:', error);
    console.log('ℹ️ Создайте таблицу:');
    console.log(`
      CREATE TABLE chat_members (
        user_id BIGINT,
        chat_id BIGINT,
        username TEXT,
        birth_date TEXT,
        PRIMARY KEY (user_id, chat_id)
      );
    `);
    process.exit(1);
  }
}

// Утилиты для работы с датами
const dateUtils = {
  normalizeDate: (input) => {
  const cleaned = input.replace(/\D/g, '');
  if (cleaned.length === 3) {
    // Если ввели что-то вроде "109" - преобразуем в "01.09"
    return `${cleaned[0].padStart(2, '0')}.${cleaned.slice(1).padStart(2, '0')}`;
  }
  if (cleaned.length === 4) {
    // Если ввели что-то вроде "1509" - преобразуем в "15.09"
    return `${cleaned.slice(0, 2)}.${cleaned.slice(2).padStart(2, '0')}`;
  }
  if (cleaned.length === 2) {
    // Если ввели что-то вроде "09" - преобразуем в "09.01" (текущий день месяца)
    return `${cleaned.padStart(2, '0')}.01`; // или можно вернуть null, если не хотим принимать такой формат
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
    const { data, error } = await supabase
      .from('chat_members')
      .upsert({ 
        user_id: userId,
        chat_id: chatId,
        username: username,
        birth_date: birthDate
      }, {
        onConflict: ['user_id', 'chat_id']
      });
    
    if (error) throw error;
    return data;
  },

  getUsersByChat: async (chatId) => {
    const { data, error } = await supabase
      .from('chat_members')
      .select('*')
      .eq('chat_id', chatId);
    
    if (error) throw error;
    return data || [];
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
bot.start(async (ctx) => {
  await checkTableStructure();
  return ctx.reply('Добро пожаловать! Используйте кнопки меню:', getMainMenu());
});

// Обработчик кнопки "Добавить дату"
bot.hears('📅 Добавить дату', (ctx) => {
  return ctx.reply(
    `Отправьте дату в формате ДД.ММ, например:\n\n@${config.botUsername} 15.09`,
    Markup.removeKeyboard()
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
\`@${config.botUsername} 15.09\` - сохранит дату 15 сентября`,
    getMainMenu()
  );
});

// Обработчик текста с упоминанием бота
bot.on('text', async (ctx) => {
  const text = ctx.message.text.trim();
  
  // Проверяем содержит ли текст упоминание бота
  if (!isBotMention(text)) return;
  
  // Удаляем упоминание бота из текста
  const cleanText = text.replace(`@${config.botUsername}`, '').trim();
  
  // Обработка команды /start
  if (cleanText.startsWith('/start')) {
    return ctx.reply('Добро пожаловать! Используйте кнопки меню:', getMainMenu());
  }
  
  // Обработка даты
  try {
    const normalizedDate = dateUtils.normalizeDate(cleanText);
    
    if (!normalizedDate || !dateUtils.isValidDate(normalizedDate)) {
      return ctx.reply('❌ Неверный формат! Используйте ДД.ММ. Пример:\n\n`@' + config.botUsername + ' 15.09`');
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
  const in7Days = now.plus({ days: 7 }).toFormat('dd.MM'); // Добавляем дату через 7 дней

  try {
    const { data: users } = await supabase.from('chat_members').select('*');
    if (!users) return;

    const todayCelebrations = {};
    const upcomingCelebrations = {}; // Для уведомлений за 7 дней

    users.forEach(user => {
      if (user.birth_date === today) {
        if (!todayCelebrations[user.chat_id]) todayCelebrations[user.chat_id] = [];
        todayCelebrations[user.chat_id].push(user);
      }
      else if (user.birth_date === in7Days) { // Проверка на предстоящий ДР
        if (!upcomingCelebrations[user.chat_id]) upcomingCelebrations[user.chat_id] = [];
        upcomingCelebrations[user.chat_id].push(user);
      }
    });

    // Отправка уведомлений
    for (const chatId in todayCelebrations) {
      const mentions = todayCelebrations[chatId].map(u => 
        u.username ? `@${u.username}` : `пользователя ${u.user_id}`
      ).join(', ');
      await bot.telegram.sendMessage(chatId, `🎉 Сегодня день рождения у ${mentions}! Поздравляем! 🎂`);
    }

    // Новое: уведомления за 7 дней
    for (const chatId in upcomingCelebrations) {
      const mentions = upcomingCelebrations[chatId].map(u => 
        u.username ? `@${u.username}` : `пользователя ${u.user_id}`
      ).join(', ');
      await bot.telegram.sendMessage(
        chatId,
        `⏳ Через неделю (${in7Days}) день рождения у ${mentions}! Не забудьте поздравить!`
      );
    }
  } catch (error) {
    console.error('Ошибка проверки дней рождений:', error);
  }
}

// Запуск бота
async function start() {
  await checkTableStructure();
  
  // Проверка при старте и каждые 24 часа
  await checkBirthdays();
  setInterval(checkBirthdays, 24 * 60 * 60 * 1000);

  bot.launch();
  console.log('Бот успешно запущен');
}

// Обработка ошибок
bot.catch((err, ctx) => {
  console.error('Ошибка:', err);
  ctx.reply('⚠️ Произошла ошибка. Попробуйте позже', getMainMenu());
});

process.on('unhandledRejection', (err) => {
  console.error('Необработанная ошибка:', err);
});

start().catch(err => {
  console.error('Ошибка запуска:', err);
  process.exit(1);
});