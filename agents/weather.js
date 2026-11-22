// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Vitaliy Bondar

// Agent: 3-day weather forecast (open-meteo)
// Call: run_agent({script:"weather.js", args:["Moscow"]})
// In: argv[2]=city
// Out: stdout: forecast as text

import https from 'node:https';

const cityName = process.argv[2];

if (!cityName) {
  console.error('Usage: node weather.js <city_name>');
  process.exit(1);
}

const weatherCodes = {
  0: { ru: 'Clear', emoji: '☀️' },
  1: { ru: 'Mainly clear', emoji: '🌤️' },
  2: { ru: 'Partly cloudy', emoji: '⛅' },
  3: { ru: 'Cloudy', emoji: '☁️' },
  45: { ru: 'Fog', emoji: '🌫️' },
  48: { ru: 'Depositing rime fog', emoji: '🌫️' },
  51: { ru: 'Light drizzle', emoji: '🌦️' },
  53: { ru: 'Drizzle', emoji: '🌦️' },
  55: { ru: 'Dense drizzle', emoji: '🌧️' },
  61: { ru: 'Slight rain', emoji: '🌧️' },
  63: { ru: 'Rain', emoji: '🌧️' },
  65: { ru: 'Heavy rain', emoji: '⛈️' },
  71: { ru: 'Slight snow', emoji: '🌨️' },
  73: { ru: 'Snow', emoji: '🌨️' },
  75: { ru: 'Heavy snow', emoji: '🌨️' },
  77: { ru: 'Snow grains', emoji: '🌨️' },
  80: { ru: 'Slight rain showers', emoji: '🌧️' },
  81: { ru: 'Rain showers', emoji: '⛈️' },
  82: { ru: 'Violent rain showers', emoji: '⛈️' },
  85: { ru: 'Slight snow showers', emoji: '🌨️' },
  86: { ru: 'Heavy snow showers', emoji: '🌨️' },
  95: { ru: 'Thunderstorm', emoji: '⛈️' },
  96: { ru: 'Thunderstorm with hail', emoji: '⛈️' },
  99: { ru: 'Thunderstorm with heavy hail', emoji: '⛈️' },
};

const dayNames = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

const ruToEnMap = {
  'а': 'a', 'б': 'b', 'в': 'v', 'г': 'g', 'д': 'd', 'е': 'e', 'ё': 'yo', 'ж': 'zh',
  'з': 'z', 'и': 'i', 'й': 'y', 'к': 'k', 'л': 'l', 'м': 'm', 'н': 'n', 'о': 'o',
  'п': 'p', 'р': 'r', 'с': 's', 'т': 't', 'у': 'u', 'ф': 'f', 'х': 'kh', 'ц': 'ts',
  'ч': 'ch', 'ш': 'sh', 'щ': 'shch', 'ъ': '', 'ы': 'y', 'ь': '', 'э': 'e', 'ю': 'yu',
  'я': 'ya',
  'А': 'A', 'Б': 'B', 'В': 'V', 'Г': 'G', 'Д': 'D', 'Е': 'E', 'Ё': 'Yo', 'Ж': 'Zh',
  'З': 'Z', 'И': 'I', 'Й': 'Y', 'К': 'K', 'Л': 'L', 'М': 'M', 'Н': 'N', 'О': 'O',
  'П': 'P', 'Р': 'R', 'С': 'S', 'Т': 'T', 'У': 'U', 'Ф': 'F', 'Х': 'Kh', 'Ц': 'Ts',
  'Ч': 'Ch', 'Ш': 'Sh', 'Щ': 'Shch', 'Ъ': '', 'Ы': 'Y', 'Ь': '', 'Э': 'E', 'Ю': 'Yu',
  'Я': 'Ya'
};

function transliterate(str) {
  return str.split('').map(char => ruToEnMap[char] || char).join('');
}

function httpsGet(url) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, { timeout: 15_000 }, (res) => {
      if (res.statusCode && (res.statusCode < 200 || res.statusCode >= 300)) {
        res.resume();
        reject(new Error(`HTTP ${res.statusCode} for ${url}`));
        return;
      }
      let data = '';
      res.on('data', (chunk) => { data += chunk; });
      res.on('end', () => {
        try {
          resolve(JSON.parse(data));
        } catch (e) {
          reject(new Error(`Failed to parse JSON: ${e.message}`));
        }
      });
    });
    req.on('timeout', () => {
      req.destroy(new Error('Request timeout'));
    });
    req.on('error', reject);
  });
}

async function getWeatherForecast() {
  try {
    // Transliterate city name if it contains Cyrillic characters
    const hasCyrillic = /[а-яА-ЯёЁ]/.test(cityName);
    const searchCity = hasCyrillic ? transliterate(cityName) : cityName;

    const geoUrl = `https://geocoding-api.open-meteo.com/v1/search?name=${encodeURIComponent(searchCity)}&count=5&language=en&format=json`;
    const geoData = await httpsGet(geoUrl);
    
    if (!geoData.results || geoData.results.length === 0) {
      console.error(`City "${cityName}" not found`);
      process.exit(1);
    }

    let selectedCity = geoData.results[0];
    const exactMatch = geoData.results.find(city => 
      city.name && 
      (city.name.toLowerCase() === cityName.toLowerCase() || 
       city.name.toLowerCase() === searchCity.toLowerCase())
    );
    
    if (exactMatch) {
      selectedCity = exactMatch;
    } else {
      console.error(`Warning: No exact match found for "${cityName}". Using "${selectedCity.name}" instead.`);
    }
    
    const { latitude, longitude, name } = selectedCity;
    
    const forecastUrl = `https://api.open-meteo.com/v1/forecast?latitude=${latitude}&longitude=${longitude}&daily=temperature_2m_max,temperature_2m_min,weather_code,wind_speed_10m_max,relative_humidity_2m_max&timezone=auto`;
    const forecastData = await httpsGet(forecastUrl);
    
    const daily = forecastData.daily;
    const dates = daily.time;
    const tempMax = daily.temperature_2m_max;
    const tempMin = daily.temperature_2m_min;
    const codes = daily.weather_code;
    const windSpeed = daily.wind_speed_10m_max;
    const humidity = daily.relative_humidity_2m_max;
    
    const forecasts = [];
    for (let i = 0; i < 3 && i < dates.length; i++) {
      const date = new Date(dates[i] + 'T00:00:00Z');
      const dayOfWeek = dayNames[date.getDay()];
      const code = codes[i];
      const weatherInfo = weatherCodes[code] || { ru: 'Unknown', emoji: '❓' };
      
      forecasts.push({
        date: dates[i],
        day: dayOfWeek,
        tempMin: Math.round(tempMin[i]),
        tempMax: Math.round(tempMax[i]),
        condition: weatherInfo.ru,
        windKph: Math.round(windSpeed[i]),
        humidity: Math.round(humidity[i]),
        emoji: weatherInfo.emoji,
      });
    }
    
    const result = {
      city: name,
      forecasts,
    };

    // The header promises "forecast as text" — text it is.
    const lines = [`Weather in ${result.city}, 3 days:`];
    for (const f of forecasts) {
      lines.push(`${f.date} ${f.day}: ${f.emoji} ${f.condition}, ${f.tempMin}…${f.tempMax}°C, wind ${f.windKph} km/h, humidity ${f.humidity}%`);
    }
    console.log(lines.join('\n'));
  } catch (error) {
    console.error(`Error: ${error.message}`);
    process.exit(1);
  }
}

getWeatherForecast();