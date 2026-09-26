/* Browser-demo AI overlay. Mirrors ai/findings.json. Keyed by element id. */
window.SEED_FINDINGS = {
  el_1011: [{ id: 'f1', element_id: 'el_1011', document_id: 'd1', kind: 'Сечение воздуховода', severity: 'err', confidence: 0.92, text: 'На чертеже АР-12 сечение 500×300 мм, в модели 600×300 мм — расхождение с проектом.' }],
  el_1012: [{ id: 'f2', element_id: 'el_1012', document_id: 'd3b', kind: 'Паспорт оборудования', severity: 'ok', confidence: 0.88, text: 'Модель ПВ-1 соответствует паспорту и смете.' }],
  el_1013: [{ id: 'f3', element_id: 'el_1013', document_id: 'd1', kind: 'Диаметр воздуховода', severity: 'ok', confidence: 0.80, text: 'Ø400 совпадает с проектным значением.' }],
  el_1014: [{ id: 'f4', element_id: 'el_1014', document_id: 'd3', kind: 'Класс огнестойкости', severity: 'warn', confidence: 0.70, text: 'В акте указано EI-60, в модели дверь без класса — требуется уточнение.' }],
  el_1021: [{ id: 'f5', element_id: 'el_1021', document_id: 'd4', kind: 'Номинал ГРЩ', severity: 'ok', confidence: 0.85, text: 'ГРЩ-1 соответствует однолинейной схеме ЭО-3.' }],
  el_1023: [{ id: 'f6', element_id: 'el_1023', document_id: 'd5', kind: 'Кабельный лоток', severity: 'ok', confidence: 0.80, text: 'Типоразмер лотка КЛ-1 соответствует смете.' }],
  el_1031: [{ id: 'f7', element_id: 'el_1031', document_id: 'd6', kind: 'Габарит двери', severity: 'ok', confidence: 0.78, text: 'Дверь Д-3 совпадает с планом АР-15.' }],
  el_2011: [{ id: 'f8', element_id: 'el_2011', document_id: 'd7', kind: 'Нагрузка на фальшпол', severity: 'warn', confidence: 0.72, text: 'Вес стойки близок к пределу фальшпола — требуется проверка несущей способности.' }],
  el_2012: [{ id: 'f9', element_id: 'el_2012', document_id: 'd7', kind: 'Трасса кондиционера', severity: 'ok', confidence: 0.75, text: 'Маршрут трассы совпадает с проектом.' }],
  el_2014: [{ id: 'f10', element_id: 'el_2014', document_id: null, kind: 'Класс двери', severity: 'ok', confidence: 0.77, text: 'Дверь EI-30 соответствует требованиям.' }],
  el_2021: [],
  el_2022: [{ id: 'f11', element_id: 'el_2022', document_id: 'd9', kind: 'Площадь остекления', severity: 'warn', confidence: 0.68, text: 'Витраж Б-1 больше проектного на 8% — уточнить у архитектора.' }]
};
window.SEED_STATUS = { el_1011: 'err', el_1012: 'ok', el_1013: 'ok', el_1014: 'warn', el_1021: 'ok', el_1023: 'ok', el_1031: 'ok', el_1032: 'none', el_2011: 'warn', el_2012: 'ok', el_2014: 'ok', el_2021: 'none', el_2022: 'warn' };
