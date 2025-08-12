const { Telegraf } = require('telegraf');
const { Low } = require('lowdb');
const { JSONFile } = require('lowdb/node');
const { scheduleJob } = require('node-schedule');
const { DateTime } = require('luxon');

// Инициализация базы данных
const adapter = new JSONFile('db.json');
const db = new Low(adapter, { users: [] });

const bot = new Telegraf('476971889:AAHqIoP0f3hTF7K79JD4_VON8to_awhu9_g');

// Настройка временной зоны (Москва)
const TIMEZONE = 'Europe/Moscow';

// Функция проверки дней рождения
async function checkBirthdays() {
  const now = DateTime.now().setZone(TIMEZONE);
  const today = now.toFormat('dd.MM');

  await db.read();
  
  db.data.users.forEach(user => {
    if (user.birthDate === today) {
      bot.telegram.sendMessage(
        user.id,
        `🎉 ${user.name}, сегодня твой день! 🎂\nДата рождения: ${user.birthDate}`
      );
    }
  });
}

// Обработчик команды /start
bot.start((ctx) => {
  ctx.reply('Привет! Отправь дату рождения в формате ДД.ММ (например, 31.12)');
});

// Обработчик текстовых сообщений
bot.on('text', async (ctx) => {
  try {
    const userId = ctx.from.id;
    const userName = ctx.from.first_name || 'Пользователь';
    const birthDate = ctx.message.text.trim();

    // Проверка формата даты
    if (!/^\d{2}\.\d{2}$/.test(birthDate)) {
      return ctx.reply('❌ Неверный формат! Используй ДД.ММ (например, 31.12)');
    }

    // Сохранение данных
    await db.read();
    
    const userIndex = db.data.users.findIndex(u => u.id === userId);
    if (userIndex >= 0) {
      db.data.users[userIndex].birthDate = birthDate;
    } else {
      db.data.users.push({ id: userId, name: userName, birthDate });
    }

    await db.write();
    ctx.reply(`✅ Дата ${birthDate} сохранена! Уведомлю, когда наступит этот день!`);
  } catch (error) {
    console.error('Ошибка:', error);
    ctx.reply('❌ Ошибка при сохранении данных.');
  }
});

// Планировщик (проверка каждый день в 09:00 по Москве)
scheduleJob('0 9 * * *', () => {
  console.log('Проверяем дни рождения...');
  checkBirthdays();
});

// Запуск бота
bot.launch()
  .then(() => {
    console.log('Бот запущен!');
    // Первая проверка при старте
    checkBirthdays(); 
  })
  .catch(err => console.error('Ошибка запуска:', err));