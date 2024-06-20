# lista-claim

## Как запустить
Для работы требуется установленный Node.js v18 или выше (https://nodejs.org/en/download)

Нужно открыть CMD, перейти в папку с софтом и выполнить следующие команды:

Установка зависимостей
```bash
npm install
```

Запуск
```bash
npm start
```

## Формат кошельков в data/wallets.txt

Адрес для вывода опциональный, если его указать софт выведет все монеты на него после клейма.

```txt
privateKey:withdrawAddress

// Пример

0x0000001
0x0000002:0x0000003
```

## Формат прокси в data/proxies.txt

Прокси опциональные и нужны только для загрузки аллокации с lista.org/airdrop

```txt
http://user:pass@127.0.0.1:1234
ИЛИ
127.0.0.1:1234:user:pass
```

## Как изменить RPC или цену газа?
В файле main.js сверху есть переменные `rpcUrls` и `gasPrice`.

Софт будет использовать сразу все указанные RPC, для оптимизации задержек и исключения ошибок из-за перегрузки.

Значения по умолчанию:
```js
const rpcUrls = [
  'https://rpc.ankr.com/bsc',
  'https://bsc.drpc.org',
  'https://bsc.meowrpc.com',
  'https://binance.llamarpc.com',
];
const gasPrice = {
  // Используется при клейме монеты
  claim: {
    gasPrice: ethers.parseUnits('3', 'gwei'),
  },
  // Используется при выводе монеты на указанный адрес
  withdraw: {
    gasPrice: ethers.parseUnits('3', 'gwei'),
  },
};
```
