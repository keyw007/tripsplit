// 語音／文字記帳的離線解析（不需要網路）。
// 例：「午餐拉麵 2400 日圓 郁文付 平分」→ 標題、金額、幣別、支付者、分攤對象、類別

export const CATEGORIES = [
  { id: 'food', label: '餐費', icon: '🍜', words: ['午餐', '晚餐', '早餐', '宵夜', '拉麵', '蕎麥', '烏龍', '壽司', '燒肉', '定食', '便當', '咖啡', '咖哩', '漢堡', '吃', '餐', '居酒屋', '飲料', '啤酒', '酒', '甜點', '麵'] },
  { id: 'snack', label: '零食超商', icon: '🍙', words: ['超商', '便利商店', '7-11', '711', '全家', 'lawson', '羅森', '超市', '零食', '行動糧', '水', '補給'] },
  { id: 'transport', label: '交通', icon: '🚃', words: ['巴士', '公車', '電車', 'jr', '新幹線', '特急', '地鐵', '計程車', 'taxi', '車票', '纜車', '交通', '名鐵', '接駁', '火車', '機場', '油錢', '停車'] },
  { id: 'lodging', label: '住宿', icon: '🏨', words: ['住宿', '飯店', '旅館', '民宿', '山屋', '山莊', '小屋', 'hotel', '溫泉旅館', '入湯稅', '溫泉稅'] },
  { id: 'ticket', label: '門票', icon: '🎫', words: ['門票', '入場', '票', '博物館', '展覽', '陣屋', '飛驒之里', '飛騨の里'] },
  { id: 'shopping', label: '購物', icon: '🛍️', words: ['伴手禮', '禮物', '紀念品', '購物', '藥妝', '衣服', '買'] },
  { id: 'other', label: '其他', icon: '📌', words: ['置物櫃', '寄物', '唱歌', '卡拉ok', '保險', '網路', 'esim', '手續費'] },
];

const CURRENCY_WORDS = [
  { code: 'JPY', re: /(日圓|日幣|日元|円|えん|yen|jpy)/i },
  { code: 'TWD', re: /(台幣|新台幣|臺幣|twd|ntd|nt\$)/i },
  { code: 'USD', re: /(美金|美元|usd)/i },
  { code: 'KRW', re: /(韓元|韓幣|krw)/i },
  { code: 'EUR', re: /(歐元|eur)/i },
  { code: 'HKD', re: /(港幣|港元|hkd)/i },
];

const CN_DIGIT = { 零: 0, 〇: 0, 一: 1, 二: 2, 兩: 2, 两: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9 };
const CN_UNIT = { 十: 10, 百: 100, 千: 1000 };

// 中文數字轉阿拉伯數字：兩千四百 → 2400、三千五 → 3500、一萬二 → 12000、十五 → 15
export function cnToNumber(s) {
  let result = 0;
  let section = 0;
  let number = 0;
  let lastUnit = 1;
  for (const ch of s) {
    if (ch in CN_DIGIT) {
      number = CN_DIGIT[ch];
    } else if (ch in CN_UNIT) {
      const u = CN_UNIT[ch];
      if (number === 0 && u === 10) number = 1;
      section += number * u;
      number = 0;
      lastUnit = u;
    } else if (ch === '萬' || ch === '万') {
      section += number;
      result += section * 10000;
      section = 0;
      number = 0;
      lastUnit = 10000;
    }
  }
  if (number) section += lastUnit >= 100 ? number * (lastUnit / 10) : number;
  return result + section;
}

function escapeRe(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function findAmount(text) {
  // 阿拉伯數字，可帶千分位、小數、萬／千／k
  const m = text.match(/(\d[\d,]*(?:\.\d+)?)\s*(萬|万|千|k|K)?/);
  if (m) {
    let n = parseFloat(m[1].replace(/,/g, ''));
    if (m[2] === '萬' || m[2] === '万') n *= 10000;
    else if (m[2]) n *= 1000;
    return { amount: n, match: m[0] };
  }
  // 中文數字：必須含單位字（十百千萬），或後面接金額字，避免把「一起」當成 1
  const cm = text.match(/[零〇一二兩两三四五六七八九十百千萬万]+(?=\s*(元|塊|日圓|日幣|日元|円|台幣|美金|$|\s))/) ||
    text.match(/[零〇一二兩两三四五六七八九]*[十百千萬万][零〇一二兩两三四五六七八九十百千萬万]*/);
  if (cm) {
    const n = cnToNumber(cm[0]);
    if (n > 0) return { amount: n, match: cm[0] };
  }
  return null;
}

export function guessCategory(text) {
  const t = text.toLowerCase();
  for (const c of CATEGORIES) {
    if (c.words.some((w) => t.includes(w.toLowerCase()))) return c.id;
  }
  return 'other';
}

// members: [{ id, name }], meId: 我的成員 id，defaultCurrency: 沒講幣別時用的幣別
export function parseExpenseText(text, { members = [], meId = null, defaultCurrency = 'JPY', today = new Date() } = {}) {
  const raw = (text || '').trim();
  let rest = raw;
  const result = {
    title: '',
    amount: null,
    currency: defaultCurrency,
    payerId: meId,
    participantIds: null, // null 代表全部成員
    category: 'other',
    date: null,
    payMethod: null, // 'cash'、'card'，沒講就是 null
  };

  // 付款方式：「現金」「付現」→ 現金；「刷卡」「信用卡」「Suica」等 → 卡片
  if (/(現金|付現|現鈔)/.test(rest)) result.payMethod = 'cash';
  else if (/(刷卡|信用卡|卡片|西瓜卡|suica|icoca|pasmo|apple ?pay|line ?pay|街口|電子支付)/i.test(rest)) result.payMethod = 'card';
  // 直接拿掉（不留空白），「吳薰用信用卡付」才會變成「吳薰付」
  rest = rest.replace(/(用現金|付現金|現金|現鈔|用信用卡|信用卡|用卡片|卡片)/g, '').replace(/付現/g, '付');

  // 日期
  const dayOffset = /前天/.test(rest) ? -2 : /昨天|昨晚/.test(rest) ? -1 : 0;
  rest = rest.replace(/前天|昨天|昨晚|今天|今晚/g, ' ');
  const d = new Date(today);
  d.setDate(d.getDate() + dayOffset);
  result.date = d.toISOString().slice(0, 10);

  // 幣別
  for (const c of CURRENCY_WORDS) {
    if (c.re.test(rest)) {
      result.currency = c.code;
      rest = rest.replace(c.re, ' ');
      break;
    }
  }
  rest = rest.replace(/(塊錢|塊|元)/g, ' ');

  // 金額
  const a = findAmount(rest);
  if (a) {
    result.amount = a.amount;
    rest = rest.replace(a.match, ' ');
  }

  // 成員名稱對照（也接受只講名字的最後一個字，例如「薰」）
  const nameAlts = members.map((m) => ({ id: m.id, names: [m.name, ...(m.name.length >= 2 ? [m.name.slice(-2)] : [])] }));
  const nameRe = (m) => m.names.map(escapeRe).join('|');

  // 支付者：「X付」「X先付」「X出」「X刷卡」「X請客」，或「我付」
  const payVerb = '(先付|付錢|付款|付了|付|出錢|出|刷卡|刷|買單|請客|請)';
  const meMatch = rest.match(new RegExp(`我${payVerb}`));
  if (meMatch && meId) {
    result.payerId = meId;
    rest = rest.replace(meMatch[0], ' ');
  } else {
    for (const m of nameAlts) {
      const re = new RegExp(`(${nameRe(m)})${payVerb}`);
      const pm = rest.match(re);
      if (pm) {
        result.payerId = m.id;
        rest = rest.replace(pm[0], ' ');
        break;
      }
    }
  }

  // 分攤對象
  if (/(只算我|我自己|自己的|只有我|個人)/.test(rest)) {
    result.participantIds = meId ? [meId] : null;
    rest = rest.replace(/(只算我|我自己|自己的|只有我|個人)/g, ' ');
  } else {
    const mentioned = nameAlts.filter((m) => new RegExp(nameRe(m)).test(rest));
    const meWord = /我/.test(rest);
    if (/(只有|只算|就|和|跟|與|、)/.test(rest) && (mentioned.length >= 1)) {
      const ids = new Set(mentioned.map((m) => m.id));
      if (meWord && meId) ids.add(meId);
      if (ids.size >= 1 && ids.size < members.length) result.participantIds = [...ids];
    }
    for (const m of mentioned) rest = rest.replace(new RegExp(nameRe(m), 'g'), ' ');
  }
  rest = rest.replace(/(大家|全部|所有人|一起|平分|平均分攤|平均|分攤|兩個人|兩人|三人|只有|只算|我們)/g, ' ');

  // 類別與標題
  result.category = guessCategory(raw);
  let title = rest
    .replace(/(花了|總共|一共|共|用了|買了|的|和|跟|與|、|，|,|。|\.|！|!)/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (!title) title = CATEGORIES.find((c) => c.id === result.category)?.label || '開支';
  result.title = title;
  return result;
}
