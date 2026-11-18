// Agent: Current time ISO
// Call: run_agent({script:"time.js"})
// In: no args
// Out: stdout: ISO datetime

const now = new Date();
const options = {
  timeZone: 'Europe/Moscow',
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  second: '2-digit',
  hour12: false
};
console.log(now.toLocaleString('ru-RU', options));