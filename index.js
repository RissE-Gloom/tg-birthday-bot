require('dotenv').config();
const { Telegraf, Markup } = require('telegraf');
const { createClient } = require('@supabase/supabase-js');
const { DateTime } = require('luxon');
const express = require('express'); // Добавляем Express для health checks

// Инициализация Express для health checks
const app = express();
const PORT = process.env.PORT || 8000;

// Health check endpoint
app.get('/health', (req, res) => {
  res.status(200).json({ 
    status: 'OK', 
    timestamp: new Date().toISOString(),
    service: 'telegram-birthday-bot'
  });
});

// Конфигурация
const config = {
  botToken: process.env.TELEGRAM_BOT_TOKEN,
  supabaseUrl: process.env.SUPABASE_URL,
  supabaseKey: process.env.SUPABASE_KEY,
  timezone: process.env.TIMEZONE || 'Europe/Moscow',
  botUsername: 'lkworm_bot'
};

// Проверка обязательных переменных
if (!config.botToken || !config.supabaseUrl || !config.supabaseKey) {
  console.error('❌ Отсутствуют обязательные переменные окружения');
  process.exit(1);
}

// Инициализация клиентов
const supabase = createClient(config.supabaseUrl, config.supabaseKey);
const bot = new Telegraf(config.botToken);

// Глобальный обработчик ошибок
bot.catch((err, ctx) => {
  console.error('❌ Глобальная ошибка бота:', err);
  try {
    if (ctx && ctx.reply) {
      ctx.reply('⚠️ Произошла ошибка. Попробуйте позже', getMainMenu());
    }
  } catch (e) {
    console.error('Ошибка при отправке сообщения об ошибке:', e);
  }
});

// Проверка структуры таблицы
async function checkTableStructure() {
  try {
    const { error } = await supabase
      .from('chat_members')
      .select('user_id, chat_id, username, birth_date')
      .limit(1);

    if (error) {
      console.error('❌ Ошибка структуры таблицы:', error);
      process.exit(1);
    }
    console.log('✅ Структура таблицы проверена');
  } catch (error) {
    console.error('❌ Ошибка при проверке таблицы:', error);
    process.exit(1);
  }
}

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
    try {
      const [day, month] = dateStr.split('.').map(Number);
      if (month < 1 || month > 12) return false;
      if (day < 1 || day > 31) return false;
      
      const months30 = [4, 6, 9, 11];
      if (months30.includes(month) && day > 30) return false;
      if (month === 2 && day > 29) return false;
      
      return true;
    } catch (error) {
      return false;
    }
  }
};

// Сервис работы с базой данных
const dbService = {
  upsertUser: async (userId, chatId, username, birthDate) => {
    try {
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
    } catch (error) {
      console.error('❌ Ошибка при сохранении пользователя:', error);
      throw error;
    }
  },

  getUsersByChat: async (chatId) => {
    try {
      const { data, error } = await supabase
        .from('chat_members')
        .select('*')
        .eq('chat_id', chatId);
      
      if (error) throw error;
      return data || [];
    } catch (error) {
      console.error('❌ Ошибка при получении пользователей:', error);
      throw error;
    }
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
  return text && text.includes(`@${config.botUsername}`);
}

// Обработчики команд с обработкой ошибок
bot.start(async (ctx) => {
  try {
    await checkTableStructure();
    return ctx.reply('Добро пожаловать! Используйте кнопки меню:', getMainMenu());
  } catch (error) {
    console.error('Ошибка в /start:', error);
    return ctx.reply('❌ Ошибка инициализации. Попробуйте позже.');
  }
});

// Обработчик кнопки "Добавить дату"
bot.hears('📅 Добавить дату', (ctx) => {
  try {
    return ctx.reply(
      `Отправьте дату в формате ДД.ММ, например:\n\n@${config.botUsername} 15.09`,
      Markup.removeKeyboard()
    );
  } catch (error) {
    console.error('Ошибка в обработчике добавления даты:', error);
  }
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
    console.error('Ошибка при получении списка:', error);
    return ctx.reply('❌ Ошибка при получении списка', getMainMenu());
  }
});

// Обработчик кнопки "Помощь"
bot.hears('ℹ️ Помощь', (ctx) => {
  try {
    return ctx.replyWithMarkdown(
      `*Как пользоваться ботом:*
1. Нажмите *"📅 Добавить дату"*
2. Отправьте \`@${config.botUsername} ДД.ММ\`
3. Используйте *"👀 Список дней рождений"* для просмотра

*Пример:*
\`@${config.botUsername} 15.09\` - сохранит дату 15 сентября`,
      getMainMenu()
    );
  } catch (error) {
    console.error('Ошибка в обработчике помощи:', error);
  }
});

// Обработчик текста с упоминанием бота
bot.on('text', async (ctx) => {
  try {
    const text = ctx.message.text.trim();
    
    if (!isBotMention(text)) return;
    
    const cleanText = text.replace(`@${config.botUsername}`, '').trim();
    
    if (cleanText.startsWith('/start')) {
      return ctx.reply('Добро пожаловать! Используйте кнопки меню:', getMainMenu());
    }
    
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
    console.error('Ошибка при обработке текста:', error);
    return ctx.reply('❌ Ошибка при сохранении данных', getMainMenu());
  }
});

// Проверка дней рождений с улучшенной обработкой ошибок
async function checkBirthdays() {
  try {
    const now = DateTime.now().setZone(config.timezone);
    const today = now.toFormat('dd.MM');
    const in7Days = now.plus({ days: 7 }).toFormat('dd.MM');

    const { data: users, error } = await supabase.from('chat_members').select('*');
    if (error) {
      console.error('❌ Ошибка при получении пользователей для проверки ДР:', error);
      return;
    }

    if (!users) return;

    const todayCelebrations = {};
    const upcomingCelebrations = {};

    users.forEach(user => {
      if (user.birth_date === today) {
        if (!todayCelebrations[user.chat_id]) todayCelebrations[user.chat_id] = [];
        todayCelebrations[user.chat_id].push(user);
      }
      else if (user.birth_date === in7Days) {
        if (!upcomingCelebrations[user.chat_id]) upcomingCelebrations[user.chat_id] = [];
        upcomingCelebrations[user.chat_id].push(user);
      }
    });

    // Отправка уведомлений с обработкой ошибок
    for (const chatId in todayCelebrations) {
      try {
        const mentions = todayCelebrations[chatId].map(u => 
          u.username ? `@${u.username}` : `пользователя ${u.user_id}`
        ).join(', ');
        await bot.telegram.sendMessage(chatId, `🎉 Сегодня день рождения у ${mentions}! Поздравляем! 🎂`);
      } catch (error) {
        console.error(`❌ Ошибка отправки уведомления в чат ${chatId}:`, error);
      }
    }

    for (const chatId in upcomingCelebrations) {
      try {
        const mentions = upcomingCelebrations[chatId].map(u => 
          u.username ? `@${u.username}` : `пользователя ${u.user_id}`
        ).join(', ');
        await bot.telegram.sendMessage(
          chatId,
          `⏳ Через неделю (${in7Days}) день рождения у ${mentions}! Не забудьте поздравить!`
        );
      } catch (error) {
        console.error(`❌ Ошибка отправки предупреждения в чат ${chatId}:`, error);
      }
    }
  } catch (error) {
    console.error('❌ Критическая ошибка в checkBirthdays:', error);
  }
}

// Улучшенный запуск бота
async function startBot() {
  try {
    await checkTableStructure();
    
    // Запускаем Express сервер
    app.listen(PORT, () => {
      console.log(`✅ Health check сервер запущен на порту ${PORT}`);
    });

    // Проверка при старте
    await checkBirthdays();
    
    // Запускаем проверку каждые 24 часа
    setInterval(checkBirthdays, 24 * 60 * 60 * 1000);
    
    // Запускаем бота
    await bot.launch();
    console.log('✅ Бот успешно запущен');
    
  } catch (error) {
    console.error('❌ Критическая ошибка при запуске:', error);
    process.exit(1);
  }
}

// Обработка graceful shutdown
process.on('SIGINT', () => {
  console.log('🛑 Остановка бота...');
  bot.stop();
  process.exit(0);
});

process.on('SIGTERM', () => {
  console.log('🛑 Остановка бота...');
  bot.stop();
  process.exit(0);
});

process.on('unhandledRejection', (err) => {
  console.error('❌ Необработанное обещание:', err);
});

process.on('uncaughtException', (err) => {
  console.error('❌ Непойманное исключение:', err);
  process.exit(1);
});

// Запускаем приложение
startBot();

start().catch(err => {
  console.error('Ошибка запуска:', err);
  process.exit(1);

});
