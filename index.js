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
  botUsername: 'lkworm_bot'
};

// Инициализация клиентов
const supabase = createClient(config.supabaseUrl, config.supabaseKey);
const bot = new Telegraf(config.botToken);

// HTTP сервер для Webhook
const server = http.createServer(async (req, res) => {
  // Health check для Koyeb
  if (req.url === '/health' && req.method === 'GET') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ 
      status: 'OK', 
      timestamp: new Date().toISOString()
    }));
    return;
  }

  // Webhook endpoint для Telegram
  if (req.url === '/webhook' && req.method === 'POST') {
    let body = '';
    req.on('data', chunk => body += chunk);
    req.on('end', async () => {
      try {
        const update = JSON.parse(body);
        await bot.handleUpdate(update);
        res.writeHead(200);
        res.end();
      } catch (error) {
        console.error('Webhook error:', error);
        res.writeHead(500);
        res.end();
      }
    });
    return;
  }

  res.writeHead(404);
  res.end();
});

// Проверка структуры таблицы
async function checkTableStructure() {
  // Проверяем основную таблицу
  const { error: mainError } = await supabase
    .from('chat_members')
    .select('user_id, chat_id, username, birth_date')
    .limit(1);

  if (mainError) {
    console.error('❌ Ошибка структуры таблицы chat_members:', mainError);
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
  }

  // Проверяем таблицу отправленных уведомлений
  const { error: notificationsError } = await supabase
    .from('sent_notifications')
    .select('notification_date, chat_id, user_id')
    .limit(1);

  if (notificationsError) {
    console.log('ℹ️ Создайте таблицу для уведомлений:');
    console.log(`
      CREATE TABLE sent_notifications (
        notification_date TEXT,
        chat_id BIGINT,
        user_id BIGINT,
        notification_type TEXT,
        created_at TIMESTAMP DEFAULT NOW(),
        PRIMARY KEY (notification_date, chat_id, user_id, notification_type)
      );
    `);
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

// Сервис работы с уведомлениями
const notificationService = {
  // Проверяем, было ли уже отправлено уведомление сегодня
  isNotificationSent: async (notificationDate, chatId, userId, notificationType = 'birthday') => {
    const { data, error } = await supabase
      .from('sent_notifications')
      .select('*')
      .eq('notification_date', notificationDate)
      .eq('chat_id', chatId)
      .eq('user_id', userId)
      .eq('notification_type', notificationType)
      .limit(1);

    if (error) {
      console.error('Ошибка проверки уведомления:', error);
      return false;
    }

    return data && data.length > 0;
  },

  // Помечаем уведомление как отправленное
  markNotificationSent: async (notificationDate, chatId, userId, notificationType = 'birthday') => {
    const { error } = await supabase
      .from('sent_notifications')
      .upsert({
        notification_date: notificationDate,
        chat_id: chatId,
        user_id: userId,
        notification_type: notificationType
      }, {
        onConflict: ['notification_date', 'chat_id', 'user_id', 'notification_type']
      });

    if (error) {
      console.error('Ошибка сохранения уведомления:', error);
    }
  },

  // Очищаем старые уведомления (старше 2 дней)
  cleanupOldNotifications: async () => {
    const twoDaysAgo = DateTime.now().minus({ days: 2 }).toFormat('dd.MM');
    const { error } = await supabase
      .from('sent_notifications')
      .delete()
      .lt('notification_date', twoDaysAgo);

    if (error) {
      console.error('Ошибка очистки уведомлений:', error);
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
  const in7Days = now.plus({ days: 7 }).toFormat('dd.MM');

  try {
    const { data: users } = await supabase.from('chat_members').select('*');
    if (!users) return;

    // Очищаем старые уведомления
    await notificationService.cleanupOldNotifications();

    const todayCelebrations = {};
    const upcomingCelebrations = {};

    // Собираем пользователей с днями рождения
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

    // Отправка уведомлений о сегодняшних днях рождения
    for (const chatId in todayCelebrations) {
      const usersToCongratulate = [];
      
      for (const user of todayCelebrations[chatId]) {
        // Проверяем, не отправляли ли уже уведомление сегодня
        const alreadySent = await notificationService.isNotificationSent(today, chatId, user.user_id, 'birthday');
        
        if (!alreadySent) {
          usersToCongratulate.push(user);
          // Помечаем как отправленное
          await notificationService.markNotificationSent(today, chatId, user.user_id, 'birthday');
        }
      }

      if (usersToCongratulate.length > 0) {
        const mentions = usersToCongratulate.map(u => 
          u.username ? `@${u.username}` : `пользователя ${u.user_id}`
        ).join(', ');

        await bot.telegram.sendMessage(
          chatId,
          `🎉 Сегодня день рождения у ${mentions}! Поздравляем! 🎂`
        );
      }
    }

    // Отправка уведомлений за 7 дней
    for (const chatId in upcomingCelebrations) {
      const usersToNotify = [];
      
      for (const user of upcomingCelebrations[chatId]) {
        // Проверяем, не отправляли ли уже уведомление о предстоящем ДР
        const alreadySent = await notificationService.isNotificationSent(in7Days, chatId, user.user_id, 'reminder');
        
        if (!alreadySent) {
          usersToNotify.push(user);
          // Помечаем как отправленное
          await notificationService.markNotificationSent(in7Days, chatId, user.user_id, 'reminder');
        }
      }

      if (usersToNotify.length > 0) {
        const mentions = usersToNotify.map(u => 
          u.username ? `@${u.username}` : `пользователя ${u.user_id}`
        ).join(', ');

        await bot.telegram.sendMessage(
          chatId,
          `⏳ Через неделю (${in7Days}) день рождения у ${mentions}! Не забудьте поздравить!`
        );
      }
    }
  } catch (error) {
    console.error('Ошибка проверки дней рождений:', error);
  }
}

// Запуск бота с Webhook
async function start() {
  await checkTableStructure();
  await checkBirthdays();
  setInterval(checkBirthdays, 24 * 60 * 60 * 1000);

  // Настройка Webhook вместо polling
  const webhookUrl = `https://${process.env.KOYEB_APP_NAME}.koyeb.app/webhook`;
  await bot.telegram.setWebhook(webhookUrl);
  console.log('✅ Webhook установлен:', webhookUrl);

  // Запуск HTTP сервера
  server.listen(8000, () => {
    console.log('✅ HTTP сервер запущен на порту 8000');
  });
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
