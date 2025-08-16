const { Telegraf } = require('telegraf');
const { createClient } = require('@supabase/supabase-js');
const { DateTime } = require('luxon');

// Инициализация Supabase
const supabase = createClient(
  'https://wttruqdkpbxhoylacjuv.supabase.co',
  'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Ind0dHJ1cWRrcGJ4aG95bGFjanV2Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3NTUwNDA4OTAsImV4cCI6MjA3MDYxNjg5MH0.AnygEr0ZY-GFtjf8FSbvQpKptXenYKbPfNp1OFnzYE8'
);

const bot = new Telegraf('476971889:AAHqIoP0f3hTF7K79JD4_VON8to_awhu9_g');

// Функция для проверки дат и отправки уведомлений
async function checkUpcomingBirthdays() {
  const now = DateTime.now().setZone('Europe/Moscow');
  const today = now.toFormat('dd.MM');
  const in7Days = now.plus({ days: 7 }).toFormat('dd.MM');

  // Получаем всех пользователей
  const { data: users, error } = await supabase
    .from('users')
    .select('*');

  if (error) {
    console.error('Ошибка Supabase:', error);
    return;
  }

  // Проверяем каждую запись
  for (const user of users) {
    // Если сегодня день рождения
    if (user.birth_date === today) {
      await bot.telegram.sendMessage(
        user.telegram_id,
        `🎉 ${user.name}, сегодня твой день рождения! 🎂`
      );
    }
    // Если до дня рождения 7 дней
    else if (user.birth_date === in7Days) {
      await bot.telegram.sendMessage(
        user.telegram_id,
        `⏳ ${user.name}, через неделю (${user.birth_date}) будет твой день рождения!`
      );
    }
  }
}

// Проверка каждые 24 часа
setInterval(checkUpcomingBirthdays, 24 * 60 * 60 * 1000);

// Обработчик сообщений
bot.on('text', async (ctx) => {
  const { id, first_name } = ctx.from;
  const inputDate = ctx.message.text.trim();

  // Нормализация даты (поддержка разных форматов)
  const normalizedDate = inputDate
    .replace(/\D/g, '') // Удаляем все нецифровые символы
    .replace(/^(\d{1,2})(\d{2})$/, '$1.$2'); // Форматируем в ДД.ММ

  if (!/^\d{2}\.\d{2}$/.test(normalizedDate)) {
    return ctx.reply('❌ Неверный формат! Используй ДД.ММ (например, 31.12)');
  }

  // Сохранение в Supabase
  const { error } = await supabase
    .from('users')
    .upsert({ 
      telegram_id: id, 
      name: first_name || 'Пользователь', 
      birth_date: normalizedDate 
    });

  if (error) {
    console.error(error);
    return ctx.reply('❌ Ошибка сохранения данных.');
  }

  ctx.reply(`✅ Дата "${normalizedDate}" сохранена! Я напомню за неделю и в день события.`);
});

// Первая проверка при запуске
checkUpcomingBirthdays();

bot.launch();
console.log('Бот запущен и мониторит дни рождения...');
