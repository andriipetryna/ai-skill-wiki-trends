// The synthetic Wikipedia/Wikidata that the fake API (fetch.ts) serves. Every series is generated, so the right
// answers are known: they are written next to the data. QIDs named in .specs/09 are the real ones; the others
// (Q90000xx) are made up.
import { gens, type MonthSeries } from "./noise.ts";

export interface FakeArticle {
  qid?: string;
  description?: string;
  disambiguation?: true;
  /** this title redirects to another title of the same edition */
  redirectTo?: string;
  /** monthly user pageviews; absent = the Pageviews API has no data for the title (404) */
  views?: MonthSeries;
}

export interface FakeEdition {
  /** whole-edition monthly user pageviews (the aggregate endpoint) */
  views: MonthSeries;
  articles: Record<string, FakeArticle>;
  /** full-text search: lowercased query -> titles by relevance. Other queries match titles containing the query. */
  search?: Record<string, string[]>;
}

export interface FakeEntity {
  /** language -> label */
  labels: Record<string, string>;
}

export interface FakeWorld {
  /** keyed by Wikipedia language code */
  editions: Record<string, FakeEdition>;
  /** Wikidata items. Sitelinks are derived from the editions' articles that carry the QID. */
  entities: Record<string, FakeEntity>;
}

/** Seasonality of reference topics: school year, low in summer. */
const SCHOOL = { season: 0.2, peak: 10 };
const NZ = 0.05;

/**
 * Ground truth (trends in %/yr; "share" = topic views / edition views, so share ≈ (1 + views) / (1 + edition) − 1):
 *
 * Editions: en −3, de −6, pl −4, cs −2, uk −12, hu −5, ro −8.
 *
 * Intermittent fasting (Q1666254)
 *   en  Intermittent fasting        55 000/mo, +5
 *   cs  Přerušovaný půst            1 600/mo, flat views (share ≈ +2 → flat), ×6 spike in 2025-10;
 *                                   redirect "Intermitentní půst" 60/mo flat
 *   pl  no sitelink (as in reality). Search "Intermittent fasting" → Stres oksydacyjny (1), Głodówka lecznicza (2)
 *   pl  Głodówka lecznicza (Q9000011)  900/mo, views +35 (share ≈ +41 → growing)
 *   pl  Stres oksydacyjny  (Q9000012)  1 300/mo, flat views
 *
 * Astronomy (Q333)
 *   en  Astronomy     250 000/mo, −2
 *   uk  Астрономія      9 000/mo, views +4, edition −12 → share ≈ +18.2 (1.04 / 0.88 − 1): normalization in action
 *   pl  Astronomia      7 000/mo, views −4 = the pl edition → share flat
 *
 * English language (Q1860) + English as a second or foreign language (Q1321), a basket
 *   pl  Język angielski 14 000 −4  + Angielski jako język obcy 700 flat      → share ≈ flat
 *   cs  Angličtina       5 000 −4                                            → share ≈ −2
 *   uk  Англійська мова 22 000 +20 + Англійська як іноземна 1 800 +25;
 *       redirect "Англійська" 400 flat                                       → share ≈ +37, ranks first
 *   de  Englische Sprache 16 000 −8                                          → share ≈ −2
 *   hu  Angol nyelv       3 500 flat                                         → share ≈ +5
 *   ro  Limba engleză        70 +5 (median ≈ 70/mo → low confidence)         → share ≈ +14
 *   Q1321 is missing in cs, de, hu, ro.
 *
 * Mercury: en "Mercury" is a disambiguation page; search → Mercury (planet) Q308, Mercury (element) Q925
 *   → an ambiguous topic with exactly these two candidates.
 */
export function demoWorld(): FakeWorld {
  return {
    editions: {
      en: {
        views: gens.growth(7_000_000_000, -3, { season: 0.04, noise: 0.02, seed: 1000 }),
        articles: {
          "Intermittent fasting": { qid: "Q1666254", description: "Eating pattern", views: gens.growth(55_000, 5, { season: 0.15, noise: NZ, seed: 1100 }) },
          Astronomy: { qid: "Q333", description: "Scientific study of celestial phenomena", views: gens.growth(250_000, -2, { ...SCHOOL, noise: NZ, seed: 1200 }) },
          "English language": { qid: "Q1860", description: "West Germanic language", views: gens.growth(180_000, -2, { ...SCHOOL, noise: NZ, seed: 1300 }) },
          "English as a second or foreign language": {
            qid: "Q1321",
            description: "Use of English by speakers with different native languages",
            views: gens.flat(20_000, { ...SCHOOL, noise: NZ, seed: 1400 }),
          },
          Mercury: { qid: "Q9000001", disambiguation: true, description: "Topics referred to by the same term", views: gens.flat(8_000, { noise: NZ, seed: 1500 }) },
          "Mercury (planet)": { qid: "Q308", description: "Smallest and closest planet to the Sun", views: gens.flat(120_000, { noise: NZ, seed: 1600 }) },
          "Mercury (element)": { qid: "Q925", description: "Chemical element with atomic number 80", views: gens.flat(60_000, { noise: NZ, seed: 1700 }) },
        },
        search: { mercury: ["Mercury (planet)", "Mercury (element)", "Mercury"] },
      },
      pl: {
        views: gens.growth(180_000_000, -4, { season: 0.05, noise: 0.02, seed: 2000 }),
        articles: {
          "Głodówka lecznicza": { qid: "Q9000011", description: "metoda terapeutyczna", views: gens.growth(900, 35, { season: 0.1, noise: NZ, seed: 2100 }) },
          "Stres oksydacyjny": { qid: "Q9000012", description: "zaburzenie równowagi oksydacyjno-redukcyjnej", views: gens.flat(1_300, { noise: NZ, seed: 2200 }) },
          Astronomia: { qid: "Q333", description: "nauka przyrodnicza", views: gens.growth(7_000, -4, { ...SCHOOL, noise: NZ, seed: 2300 }) },
          "Język angielski": { qid: "Q1860", description: "język zachodniogermański", views: gens.growth(14_000, -4, { ...SCHOOL, noise: NZ, seed: 2400 }) },
          "Angielski jako język obcy": { qid: "Q1321", views: gens.flat(700, { ...SCHOOL, noise: NZ, seed: 2500 }) },
        },
        search: { "intermittent fasting": ["Stres oksydacyjny", "Głodówka lecznicza"] },
      },
      cs: {
        views: gens.growth(80_000_000, -2, { season: 0.05, noise: 0.02, seed: 3000 }),
        articles: {
          "Přerušovaný půst": {
            qid: "Q1666254",
            description: "stravovací režim",
            views: gens.flat(1_600, { season: 0.15, noise: NZ, seed: 3100, spikes: { "2025-10": 6 } }),
          },
          "Intermitentní půst": { redirectTo: "Přerušovaný půst", views: gens.flat(60, { noise: NZ, seed: 3200 }) },
          Angličtina: { qid: "Q1860", description: "západogermánský jazyk", views: gens.growth(5_000, -4, { ...SCHOOL, noise: NZ, seed: 3300 }) },
        },
      },
      uk: {
        views: gens.growth(70_000_000, -12, { season: 0.05, noise: 0.02, seed: 4000 }),
        articles: {
          Астрономія: { qid: "Q333", description: "природнича наука", views: gens.growth(9_000, 4, { ...SCHOOL, noise: NZ, seed: 4100 }) },
          "Англійська мова": { qid: "Q1860", description: "західногерманська мова", views: gens.growth(22_000, 20, { ...SCHOOL, noise: NZ, seed: 4200 }) },
          "Англійська як іноземна": { qid: "Q1321", views: gens.growth(1_800, 25, { ...SCHOOL, noise: NZ, seed: 4300 }) },
          Англійська: { redirectTo: "Англійська мова", views: gens.flat(400, { noise: NZ, seed: 4400 }) },
          Меркурій: { qid: "Q308", description: "найменша планета Сонячної системи", views: gens.flat(6_000, { ...SCHOOL, noise: NZ, seed: 4500 }) },
          Ртуть: { qid: "Q925", description: "хімічний елемент", views: gens.flat(4_000, { ...SCHOOL, noise: NZ, seed: 4600 }) },
        },
      },
      de: {
        views: gens.growth(800_000_000, -6, { season: 0.05, noise: 0.02, seed: 5000 }),
        articles: {
          "Englische Sprache": { qid: "Q1860", description: "westgermanische Sprache", views: gens.growth(16_000, -8, { ...SCHOOL, noise: NZ, seed: 5100 }) },
        },
      },
      hu: {
        views: gens.growth(50_000_000, -5, { season: 0.05, noise: 0.02, seed: 6000 }),
        articles: {
          "Angol nyelv": { qid: "Q1860", description: "nyugati germán nyelv", views: gens.flat(3_500, { ...SCHOOL, noise: NZ, seed: 6100 }) },
        },
      },
      ro: {
        views: gens.growth(35_000_000, -8, { season: 0.05, noise: 0.02, seed: 7000 }),
        articles: {
          "Limba engleză": { qid: "Q1860", description: "limbă germanică de vest", views: gens.growth(70, 5, { noise: 0.1, seed: 7100 }) },
        },
      },
    },
    entities: {
      Q1666254: { labels: { en: "Intermittent fasting", cs: "Přerušovaný půst" } },
      Q333: { labels: { en: "astronomy", uk: "астрономія", pl: "astronomia" } },
      Q1860: { labels: { en: "English", uk: "англійська мова", pl: "język angielski" } },
      Q1321: { labels: { en: "English as a second or foreign language" } },
      Q308: { labels: { en: "Mercury", uk: "Меркурій" } },
      Q925: { labels: { en: "mercury", uk: "ртуть" } },
      Q9000001: { labels: { en: "Mercury" } },
      Q9000011: { labels: { pl: "głodówka lecznicza" } },
      Q9000012: { labels: { en: "oxidative stress", pl: "stres oksydacyjny" } },
    },
  };
}
