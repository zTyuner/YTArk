import i18n from 'i18next';
import resources from './i18nResources.js';

InitI18next(window?.yt?.config_?.HL || navigator.language.replace(/(\-.*)/g, ''));

function InitI18next(lng) {
  i18n
    .init({
      lng,
      // YouTube may report a bare "pt" (HL or navigator.language); only the
      // regional Portuguese resources exist, so route it to pt-BR.
      fallbackLng: { pt: ['pt-BR', 'en'], default: ['en'] },
      resources,
      debug: false,
      interpolation: {
        escapeValue: false,
      }
    });
}
export default i18n;