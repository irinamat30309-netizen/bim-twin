/*
 * Seed data for the standalone (offline) demo.
 * Mirrors the SQLite schema: Project -> Floor -> Room -> Element / Document(+versions) / AI_Finding.
 * In Electron, real data comes from SQLite via window.bimAPI instead.
 *
 * Room geometry: dims {w,d,h} in metres. Elements may carry an explicit `geom`
 * hint {x,y,z,w,h,d}; otherwise the viewer auto-places them by type.
 */
window.SEED = {
  project: { id: 'prj_1', name: 'ЖК «Северный», корпус A', address: 'г. Киев', status: 'active' },
  floors: [
    { id: 'floor_1', number: 1, name: '1 этаж' },
    { id: 'floor_2', number: 2, name: '2 этаж' }
  ],
  rooms: [
    {
      id:'room_101', floor_id:'floor_1', name:'Венткамера', number:'101', type:'техническое',
      area_m2:18.0, height_m:3.2, material:'железобетон', cost:420000, status:'в работе',
      dims:{w:5.0,d:3.6,h:3.2},
      elements:[
        { id:'el_1011', type:'вентшахта', name:'Вентиляционный короб К-1', ifc_guid:'3xT9aQ', ai_status:'err' },
        { id:'el_1012', type:'оборудование', name:'Приточная установка ПУ-1', ifc_guid:'8kL2mN', ai_status:'ok' },
        { id:'el_1013', type:'труба', name:'Магистраль хол.воды', ifc_guid:'2vC5xB', ai_status:'ok' },
        { id:'el_1014', type:'дверь', name:'Дверь противопожарная EI-60', ifc_guid:'7dF1gH', ai_status:'warn' }
      ],
      documents:[
        { id:'d1', element_id:'el_1011', type:'чертёж', name:'Схема вентиляции К-1', version:3, date:'2026-07-14', author:'Проектный отдел', file:'vent_k1_v3.pdf',
          versions:[{v:1,date:'2026-05-02'},{v:2,date:'2026-06-11'},{v:3,date:'2026-07-14'}] },
        { id:'d2', element_id:'el_1011', type:'смета', name:'Смета на вентиляцию', version:1, date:'2026-07-20', author:'Сметный отдел', file:'smeta_vent.xlsx',
          versions:[{v:1,date:'2026-07-20'}] },
        { id:'d3', element_id:'el_1012', type:'паспорт', name:'Паспорт ПУ-1', version:1, date:'2026-06-30', author:'Поставщик', file:'pu1_passport.pdf',
          versions:[{v:1,date:'2026-06-30'}] },
        { id:'d3b', element_id:'el_1014', type:'сертификат', name:'Сертификат огнестойкости', version:1, date:'2026-07-01', author:'Поставщик', file:'door_ei60.pdf',
          versions:[{v:1,date:'2026-07-01'}] }
      ],
      findings:[]
    },
    {
      id:'room_102', floor_id:'floor_1', name:'Электрощитовая', number:'102', type:'техническое',
      area_m2:12.5, height_m:3.2, material:'железобетон', cost:310000, status:'готово',
      dims:{w:4.2,d:3.0,h:3.2},
      elements:[
        { id:'el_1021', type:'оборудование', name:'Главный щит ГРЩ', ifc_guid:'4mZ1kP', ai_status:'ok' },
        { id:'el_1023', type:'кабель-канал', name:'Кабельный лоток', ifc_guid:'3jD9sA', ai_status:'ok' }
      ],
      documents:[
        { id:'d4', element_id:'el_1021', type:'чертёж', name:'Однолинейная схема ГРЩ', version:2, date:'2026-05-11', author:'Проектный отдел', file:'grsh_v2.pdf',
          versions:[{v:1,date:'2026-04-03'},{v:2,date:'2026-05-11'}] },
        { id:'d5', element_id:'el_1021', type:'акт', name:'Акт выполненных работ', version:1, date:'2026-08-01', author:'Подрядчик', file:'akt_grsh.pdf',
          versions:[{v:1,date:'2026-08-01'}] }
      ],
      findings:[]
    },
    {
      id:'room_103', floor_id:'floor_1', name:'Коридор 1 эт.', number:'103', type:'общее',
      area_m2:22.0, height_m:3.0, material:'гипсокартон', cost:180000, status:'в работе',
      dims:{w:8.0,d:2.8,h:3.0},
      elements:[
        { id:'el_1031', type:'вентшахта', name:'Транзитный воздуховод', ifc_guid:'6kW2eR', ai_status:'ok' },
        { id:'el_1032', type:'дверь', name:'Дверь в тамбур', ifc_guid:'1sX8zC', ai_status:'ok' }
      ],
      documents:[
        { id:'d8', element_id:'el_1031', type:'чертёж', name:'План воздуховодов', version:1, date:'2026-06-18', author:'Проектный отдел', file:'corridor_vent.pdf',
          versions:[{v:1,date:'2026-06-18'}] }
      ],
      findings:[]
    },
    {
      id:'room_201', floor_id:'floor_2', name:'Серверная', number:'201', type:'техническое',
      area_m2:24.0, height_m:3.0, material:'газобетон', cost:560000, status:'в работе',
      dims:{w:6.0,d:4.0,h:3.0},
      elements:[
        { id:'el_2011', type:'оборудование', name:'Стойка серверная №1', ifc_guid:'2aB4cD', ai_status:'warn' },
        { id:'el_2012', type:'вентшахта', name:'Кондиционирование (чиллер)', ifc_guid:'6gH8jK', ai_status:'ok' },
        { id:'el_2014', type:'оборудование', name:'Стойка серверная №2', ifc_guid:'9zP3qW', ai_status:'ok' }
      ],
      documents:[
        { id:'d6', element_id:'el_2011', type:'чертёж', name:'План размещения стоек', version:1, date:'2026-07-28', author:'Проектный отдел', file:'server_plan.pdf',
          versions:[{v:1,date:'2026-07-28'}] },
        { id:'d7', element_id:'el_2012', type:'смета', name:'Смета на кондиционирование', version:2, date:'2026-08-05', author:'Сметный отдел', file:'smeta_hvac.xlsx',
          versions:[{v:1,date:'2026-07-30'},{v:2,date:'2026-08-05'}] }
      ],
      findings:[]
    },
    {
      id:'room_202', floor_id:'floor_2', name:'Офис открытый', number:'202', type:'рабочее',
      area_m2:45.0, height_m:3.0, material:'гипсокартон', cost:390000, status:'план',
      dims:{w:7.5,d:6.0,h:3.0},
      elements:[
        { id:'el_2021', type:'вентшахта', name:'Приточно-вытяжная', ifc_guid:'8tY6uI', ai_status:'ok' },
        { id:'el_2022', type:'труба', name:'Отопление (контур)', ifc_guid:'3rE5wQ', ai_status:'warn' }
      ],
      documents:[
        { id:'d9', element_id:'el_2022', type:'чертёж', name:'Схема отопления', version:1, date:'2026-08-08', author:'Проектный отдел', file:'heating.pdf',
          versions:[{v:1,date:'2026-08-08'}] }
      ],
      findings:[]
    }
  ]
};
