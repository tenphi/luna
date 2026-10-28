// CalendarHelper.swift — EventKit helper for Luna Apple Calendar + Reminders MCP.
//
// Handles Calendar reads/writes (including url/alerts/recurrence) and Reminders
// CRUD by uid via EventKit. Emits JSON on stdout; errors as {"error":"..."} + exit 1.
//
// Derived from MIT-licensed griches/apple-mcp (@griches/apple-calendar-mcp 1.0.0;
// Reminders CRUD follows the same EventKit patterns as @griches/apple-reminders-mcp),
// vendored in-tree by Luna. See LICENSE in this directory.

import EventKit
import Foundation

func jsonString(_ value: String) -> String {
  let escaped = value
    .replacingOccurrences(of: "\\", with: "\\\\")
    .replacingOccurrences(of: "\"", with: "\\\"")
    .replacingOccurrences(of: "\n", with: "\\n")
    .replacingOccurrences(of: "\r", with: "\\r")
    .replacingOccurrences(of: "\t", with: "\\t")
  return "\"\(escaped)\""
}
func jsonStringOrNull(_ value: String?) -> String {
  guard let v = value, !v.isEmpty else { return "null" }
  return jsonString(v)
}
func exitWithError(_ message: String) -> Never {
  let escaped = message
    .replacingOccurrences(of: "\\", with: "\\\\")
    .replacingOccurrences(of: "\"", with: "\\\"")
  print("{\"error\":\"\(escaped)\"}")
  exit(1)
}
let iso8601Formatter: ISO8601DateFormatter = {
  let f = ISO8601DateFormatter()
  f.formatOptions = [.withInternetDateTime]
  return f
}()
var displayTimeZone: TimeZone = .current
let displayFormatter: DateFormatter = {
  let f = DateFormatter()
  f.dateFormat = "EEEE, d MMMM yyyy 'at' h:mm:ss a"
  f.locale = Locale(identifier: "en_GB")
  return f
}()
func formatDisplay(_ date: Date) -> String {
  displayFormatter.timeZone = displayTimeZone
  return displayFormatter.string(from: date)
}
// Reminders can be due on a date with no time; a clock would report a phantom midnight.
let displayDateOnlyFormatter: DateFormatter = {
  let f = DateFormatter()
  f.dateFormat = "EEEE, d MMMM yyyy"
  f.locale = Locale(identifier: "en_GB")
  return f
}()
func formatDisplayDateOnly(_ date: Date) -> String {
  displayDateOnlyFormatter.timeZone = displayTimeZone
  return displayDateOnlyFormatter.string(from: date)
}
func parseISO(_ string: String) -> Date? {
  if let d = iso8601Formatter.date(from: string) { return d }
  let local = DateFormatter()
  local.dateFormat = "yyyy-MM-dd'T'HH:mm:ss"
  local.locale = Locale(identifier: "en_US_POSIX")
  local.timeZone = displayTimeZone
  return local.date(from: string)
}
func resolveTimeZoneId(_ raw: String?) -> TimeZone? {
  guard let raw, !raw.isEmpty else { return nil }
  guard let tz = TimeZone(identifier: raw) else {
    exitWithError("Invalid timezone: \(raw)")
  }
  return tz
}
func parseJSONObject(_ raw: String) -> [String: Any] {
  guard let data = raw.data(using: .utf8),
        let obj = try? JSONSerialization.jsonObject(with: data) as? [String: Any] else {
    exitWithError("Invalid JSON object: \(raw)")
  }
  return obj
}
func parseJSONArray(_ raw: String) -> [[String: Any]] {
  guard let data = raw.data(using: .utf8),
        let arr = try? JSONSerialization.jsonObject(with: data) as? [[String: Any]] else {
    exitWithError("Invalid JSON array: \(raw)")
  }
  return arr
}

// MARK: - Auth

func requestEventAccess(store: EKEventStore) -> Bool {
  var granted = false
  let semaphore = DispatchSemaphore(value: 0)
  if #available(macOS 14.0, *) {
    store.requestFullAccessToEvents { g, _ in granted = g; semaphore.signal() }
  } else {
    store.requestAccess(to: .event) { g, _ in granted = g; semaphore.signal() }
  }
  semaphore.wait()
  return granted
}
func requestReminderAccess(store: EKEventStore) -> Bool {
  var granted = false
  let semaphore = DispatchSemaphore(value: 0)
  if #available(macOS 14.0, *) {
    store.requestFullAccessToReminders { g, _ in granted = g; semaphore.signal() }
  } else {
    store.requestAccess(to: .reminder) { g, _ in granted = g; semaphore.signal() }
  }
  semaphore.wait()
  return granted
}
func ensureEventAccess(store: EKEventStore) {
  let status = EKEventStore.authorizationStatus(for: .event)
  if #available(macOS 14.0, *) {
    if status == .fullAccess { return }
  } else if status == .authorized {
    return
  }
  guard requestEventAccess(store: store) else {
    exitWithError("Calendar access denied. Please grant access in System Settings > Privacy & Security > Calendars.")
  }
}
func ensureReminderAccess(store: EKEventStore) {
  let status = EKEventStore.authorizationStatus(for: .reminder)
  if #available(macOS 14.0, *) {
    if status == .fullAccess { return }
  } else if status == .authorized {
    return
  }
  guard requestReminderAccess(store: store) else {
    exitWithError("Reminders access denied. Please grant access in System Settings > Privacy & Security > Reminders.")
  }
}

// MARK: - Recurrence / alerts helpers

let weekdayMap: [String: EKRecurrenceDayOfWeek] = [
  "SU": EKRecurrenceDayOfWeek(.sunday),
  "MO": EKRecurrenceDayOfWeek(.monday),
  "TU": EKRecurrenceDayOfWeek(.tuesday),
  "WE": EKRecurrenceDayOfWeek(.wednesday),
  "TH": EKRecurrenceDayOfWeek(.thursday),
  "FR": EKRecurrenceDayOfWeek(.friday),
  "SA": EKRecurrenceDayOfWeek(.saturday),
]
let weekdayToCode: [EKWeekday: String] = [
  .sunday: "SU", .monday: "MO", .tuesday: "TU", .wednesday: "WE",
  .thursday: "TH", .friday: "FR", .saturday: "SA",
]
func recurrenceToJSON(_ rules: [EKRecurrenceRule]?) -> String {
  guard let rule = rules?.first else { return "null" }
  let freq: String
  switch rule.frequency {
  case .daily: freq = "daily"
  case .weekly: freq = "weekly"
  case .monthly: freq = "monthly"
  case .yearly: freq = "yearly"
  @unknown default: freq = "daily"
  }
  var fields = [
    "\"frequency\":\(jsonString(freq))",
    "\"interval\":\(rule.interval)",
  ]
  if let days = rule.daysOfTheWeek, !days.isEmpty {
    let codes = days.compactMap { weekdayToCode[$0.dayOfTheWeek] }
    fields.append("\"daysOfWeek\":[\(codes.map { jsonString($0) }.joined(separator: ","))]")
  } else {
    fields.append("\"daysOfWeek\":null")
  }
  if let end = rule.recurrenceEnd {
    if let date = end.endDate {
      fields.append("\"endDate\":\(jsonString(iso8601Formatter.string(from: date)))")
      fields.append("\"occurrenceCount\":null")
    } else if end.occurrenceCount > 0 {
      fields.append("\"endDate\":null")
      fields.append("\"occurrenceCount\":\(end.occurrenceCount)")
    } else {
      fields.append("\"endDate\":null")
      fields.append("\"occurrenceCount\":null")
    }
  } else {
    fields.append("\"endDate\":null")
    fields.append("\"occurrenceCount\":null")
  }
  return "{\(fields.joined(separator: ","))}"
}
func parseRecurrenceRule(_ raw: String) -> EKRecurrenceRule {
  let obj = parseJSONObject(raw)
  guard let freqStr = obj["frequency"] as? String else {
    exitWithError("recurrence.frequency is required")
  }
  let frequency: EKRecurrenceFrequency
  switch freqStr.lowercased() {
  case "daily": frequency = .daily
  case "weekly": frequency = .weekly
  case "monthly": frequency = .monthly
  case "yearly": frequency = .yearly
  default: exitWithError("Invalid recurrence.frequency: \(freqStr)")
  }
  let interval = max(1, (obj["interval"] as? Int) ?? 1)
  var daysOfWeek: [EKRecurrenceDayOfWeek]? = nil
  if let days = obj["daysOfWeek"] as? [String], !days.isEmpty {
    daysOfWeek = days.compactMap { weekdayMap[$0.uppercased()] }
    if daysOfWeek?.isEmpty == true { daysOfWeek = nil }
  }
  var end: EKRecurrenceEnd? = nil
  if let count = obj["occurrenceCount"] as? Int, count > 0 {
    end = EKRecurrenceEnd(occurrenceCount: count)
  } else if let endStr = obj["endDate"] as? String, let d = parseISO(endStr) {
    end = EKRecurrenceEnd(end: d)
  }
  return EKRecurrenceRule(
    recurrenceWith: frequency,
    interval: interval,
    daysOfTheWeek: daysOfWeek,
    daysOfTheMonth: nil,
    monthsOfTheYear: nil,
    weeksOfTheYear: nil,
    daysOfTheYear: nil,
    setPositions: nil,
    end: end
  )
}
func applyAlerts(to item: EKCalendarItem, alertsJSON: String?) {
  guard let alertsJSON else { return }
  let alerts = parseJSONArray(alertsJSON)
  item.alarms = alerts.map { alert in
    let minutes = (alert["offsetMinutes"] as? Int) ?? 0
    return EKAlarm(relativeOffset: TimeInterval(-minutes * 60))
  }
}
func alertsJSON(from item: EKCalendarItem) -> String {
  let alarmStrs: [String] = (item.alarms ?? []).compactMap { alarm in
    guard alarm.absoluteDate == nil else { return nil }
    let offsetMinutes = Int(-alarm.relativeOffset / 60)
    return "{\"offsetMinutes\":\(offsetMinutes)}"
  }
  return "[\(alarmStrs.joined(separator: ","))]"
}

// MARK: - Calendar events

func eventToJSON(_ event: EKEvent, includeDetails: Bool = false) -> String {
  var fields = [String]()
  fields.append("\"summary\":\(jsonString(event.title ?? ""))")
  fields.append("\"startDate\":\(jsonString(formatDisplay(event.startDate)))")
  fields.append("\"endDate\":\(jsonString(formatDisplay(event.endDate)))")
  fields.append("\"location\":\(jsonStringOrNull(event.location))")
  fields.append("\"calendar\":\(jsonString(event.calendar?.title ?? ""))")
  fields.append("\"uid\":\(jsonString(event.eventIdentifier ?? ""))")
  fields.append("\"allDay\":\(event.isAllDay)")
  fields.append("\"timeZone\":\(jsonStringOrNull(event.timeZone?.identifier))")
  if includeDetails {
    fields.append("\"description\":\(jsonStringOrNull(event.notes))")
    fields.append("\"url\":\(jsonStringOrNull(event.url?.absoluteString))")
    fields.append("\"alerts\":\(alertsJSON(from: event))")
    fields.append("\"recurrence\":\(recurrenceToJSON(event.recurrenceRules))")
  }
  return "{\(fields.joined(separator: ","))}"
}
func deduplicate(_ events: [EKEvent]) -> [EKEvent] {
  var seen = Set<String>()
  var result = [EKEvent]()
  for e in events {
    let key = "\(e.title ?? "")|\(e.startDate.timeIntervalSince1970)|\(e.endDate.timeIntervalSince1970)"
    if seen.insert(key).inserted { result.append(e) }
  }
  return result
}
func normalizeQuotes(_ s: String) -> String {
  return s
    .replacingOccurrences(of: "\u{2018}", with: "'")
    .replacingOccurrences(of: "\u{2019}", with: "'")
    .replacingOccurrences(of: "\u{201C}", with: "\"")
    .replacingOccurrences(of: "\u{201D}", with: "\"")
}
func requireEvent(store: EKEventStore, uid: String) -> EKEvent {
  guard let event = store.event(withIdentifier: uid) else {
    exitWithError("Event not found: \(uid)")
  }
  return event
}
func listCalendars(store: EKEventStore) {
  let calendars = store.calendars(for: .event)
  let items = calendars.map { cal -> String in
    let desc = cal.source?.title ?? ""
    return "{\"name\":\(jsonString(cal.title)),\"description\":\(jsonString(desc))}"
  }
  print("[\(items.joined(separator: ","))]")
}
func listEvents(store: EKEventStore, from: Date, to: Date, calendarName: String?) {
  var calendars: [EKCalendar]? = nil
  if let name = calendarName {
    let matched = store.calendars(for: .event).filter { $0.title == name }
    if matched.isEmpty { exitWithError("Calendar not found: \(name)") }
    calendars = matched
  }
  let predicate = store.predicateForEvents(withStart: from, end: to, calendars: calendars)
  let events = deduplicate(store.events(matching: predicate))
  let items = events.map { eventToJSON($0) }
  print("[\(items.joined(separator: ","))]")
}
func searchEvents(store: EKEventStore, query: String, calendarName: String?) {
  var calendars: [EKCalendar]? = nil
  if let name = calendarName {
    let matched = store.calendars(for: .event).filter { $0.title == name }
    if matched.isEmpty { exitWithError("Calendar not found: \(name)") }
    calendars = matched
  }
  let from = Calendar.current.date(byAdding: .year, value: -1, to: Date())!
  let to = Calendar.current.date(byAdding: .year, value: 2, to: Date())!
  let predicate = store.predicateForEvents(withStart: from, end: to, calendars: calendars)
  let allEvents = store.events(matching: predicate)
  let queryNorm = normalizeQuotes(query.lowercased())
  let matched = deduplicate(allEvents.filter {
    normalizeQuotes(($0.title ?? "").lowercased()).contains(queryNorm)
  })
  let items = matched.map { eventToJSON($0) }
  print("[\(items.joined(separator: ","))]")
}
func getEventByUid(store: EKEventStore, uid: String) {
  let event = requireEvent(store: store, uid: uid)
  print(eventToJSON(event, includeDetails: true))
}
func createEvent(
  store: EKEventStore,
  calendarName: String,
  title: String,
  from: Date,
  to: Date,
  location: String?,
  notes: String?,
  allDay: Bool?,
  timeZoneId: String?,
  url: String?,
  alertsJSON: String?,
  recurrenceJSON: String?
) {
  let matched = store.calendars(for: .event).filter { $0.title == calendarName }
  guard let calendar = matched.first else { exitWithError("Calendar not found: \(calendarName)") }
  let event = EKEvent(eventStore: store)
  event.calendar = calendar
  event.title = title
  event.startDate = from
  event.endDate = to
  if let location { event.location = location }
  if let notes { event.notes = notes }
  if let allDay { event.isAllDay = allDay }
  if let tz = resolveTimeZoneId(timeZoneId) { event.timeZone = tz }
  if let url, let parsed = URL(string: url) { event.url = parsed }
  applyAlerts(to: event, alertsJSON: alertsJSON)
  if let recurrenceJSON {
    event.recurrenceRules = [parseRecurrenceRule(recurrenceJSON)]
  }
  do {
    try store.save(event, span: .thisEvent, commit: true)
  } catch {
    exitWithError("Failed to create event: \(error.localizedDescription)")
  }
  print(eventToJSON(event, includeDetails: true))
}
func updateEvent(
  store: EKEventStore,
  uid: String,
  title: String?,
  from: Date?,
  to: Date?,
  location: String?,
  notes: String?,
  allDay: Bool?,
  timeZoneId: String?,
  clearLocation: Bool,
  clearNotes: Bool,
  url: String?,
  clearUrl: Bool,
  alertsJSON: String?,
  clearAlerts: Bool,
  recurrenceJSON: String?,
  clearRecurrence: Bool
) {
  let event = requireEvent(store: store, uid: uid)
  if let title { event.title = title }
  if let from { event.startDate = from }
  if let to { event.endDate = to }
  if clearLocation {
    event.location = nil
  } else if let location {
    event.location = location
  }
  if clearNotes {
    event.notes = nil
  } else if let notes {
    event.notes = notes
  }
  if let allDay { event.isAllDay = allDay }
  if let tz = resolveTimeZoneId(timeZoneId) { event.timeZone = tz }
  if clearUrl {
    event.url = nil
  } else if let url {
    event.url = URL(string: url)
  }
  if clearAlerts {
    event.alarms = []
  } else if let alertsJSON {
    applyAlerts(to: event, alertsJSON: alertsJSON)
  }
  let recurrenceChanged = clearRecurrence || recurrenceJSON != nil
  if clearRecurrence {
    event.recurrenceRules = nil
  } else if let recurrenceJSON {
    event.recurrenceRules = [parseRecurrenceRule(recurrenceJSON)]
  }
  let span: EKSpan = recurrenceChanged ? .futureEvents : .thisEvent
  do {
    try store.save(event, span: span, commit: true)
  } catch {
    exitWithError("Failed to update event: \(error.localizedDescription)")
  }
  print(eventToJSON(event, includeDetails: true))
}
func deleteEvent(store: EKEventStore, uid: String) {
  let event = requireEvent(store: store, uid: uid)
  let summary = event.title ?? ""
  do {
    try store.remove(event, span: .thisEvent, commit: true)
  } catch {
    exitWithError("Failed to delete event: \(error.localizedDescription)")
  }
  print("{\"deleted\":true,\"uid\":\(jsonString(uid)),\"summary\":\(jsonString(summary))}")
}

// MARK: - Reminders

/// Reminder date components are wall-clock: read them in their own zone, or the display
/// zone when floating, so a date-only value never slides a day.
func reminderComponentsDate(_ comps: DateComponents) -> Date? {
  var cal = Calendar.current
  cal.timeZone = comps.timeZone ?? displayTimeZone
  return cal.date(from: comps)
}
func componentsAreTimed(_ comps: DateComponents) -> Bool {
  comps.hour != nil || comps.minute != nil
}
/// EventKit mirrors an unset start onto the due date, so a start equal to the due carries no
/// information — only a genuinely different one (a deferred-until date another app wrote).
func distinctStartComponents(_ reminder: EKReminder) -> DateComponents? {
  guard let start = reminder.startDateComponents else { return nil }
  if let due = reminder.dueDateComponents,
     reminderComponentsDate(due) == reminderComponentsDate(start) {
    return nil
  }
  return start
}
/// Start and due share one granularity: a date-only start strips the clock off a timed due,
/// and a timed start invents one. Follow the due date whenever there is one.
func alignedStartComponents(from start: Date, requestedAllDay: Bool, due: DateComponents?) -> DateComponents {
  let allDay = due.map { !componentsAreTimed($0) } ?? requestedAllDay
  return reminderComponents(from: start, allDay: allDay)
}
/// `<key>` + `<key>AllDay` for a due/start component pair, all-day meaning "a day, no clock".
func reminderDateFields(_ key: String, _ comps: DateComponents?) -> [String] {
  guard let comps, let date = reminderComponentsDate(comps) else {
    return ["\"\(key)\":null", "\"\(key)AllDay\":false"]
  }
  let timed = componentsAreTimed(comps)
  return [
    "\"\(key)\":\(jsonString(timed ? formatDisplay(date) : formatDisplayDateOnly(date)))",
    "\"\(key)AllDay\":\(!timed)",
  ]
}
/// Reminder alarms are usually absolute (Reminders.app writes a fixed instant); relative
/// offsets count back from the due date, as they do on events.
func reminderAlertsJSON(from reminder: EKReminder) -> String {
  let items: [String] = (reminder.alarms ?? []).map { alarm in
    if let absolute = alarm.absoluteDate {
      return "{\"date\":\(jsonString(formatDisplay(absolute)))}"
    }
    return "{\"offsetMinutes\":\(Int(-alarm.relativeOffset / 60))}"
  }
  return "[\(items.joined(separator: ","))]"
}
func applyReminderAlerts(to reminder: EKReminder, alertsJSON: String?) {
  guard let alertsJSON else { return }
  let alerts = parseJSONArray(alertsJSON)
  reminder.alarms = alerts.map { alert in
    if let dateStr = alert["date"] as? String {
      guard let date = parseISO(dateStr) else { exitWithError("Invalid alert date: \(dateStr)") }
      return EKAlarm(absoluteDate: date)
    }
    guard let minutes = alert["offsetMinutes"] as? Int else {
      exitWithError("Each alert needs a date or offsetMinutes")
    }
    return EKAlarm(relativeOffset: TimeInterval(-minutes * 60))
  }
  // A relative alarm has nothing to count back from without a due date, and EventKit
  // silently keeps the useless alarm rather than refusing it.
  if reminder.dueDateComponents == nil, reminder.alarms?.contains(where: { $0.absoluteDate == nil }) == true {
    exitWithError("A relative alert needs a due date — set --due, or use an absolute alert date")
  }
}
func reminderToJSON(_ reminder: EKReminder) -> String {
  var fields = [String]()
  fields.append("\"uid\":\(jsonString(reminder.calendarItemIdentifier))")
  fields.append("\"name\":\(jsonString(reminder.title ?? ""))")
  fields.append("\"list\":\(jsonString(reminder.calendar?.title ?? ""))")
  fields.append("\"completed\":\(reminder.isCompleted)")
  // EventKit stamps completionDate whenever isCompleted flips true (here and in Reminders.app),
  // but stays nullable — other clients and older iCloud rows can leave it unset.
  if let done = reminder.completionDate {
    fields.append("\"completedAt\":\(jsonString(formatDisplay(done)))")
  } else {
    fields.append("\"completedAt\":null")
  }
  fields.append("\"priority\":\(reminder.priority)")
  fields.append("\"body\":\(jsonStringOrNull(reminder.notes))")
  fields.append("\"url\":\(jsonStringOrNull(reminder.url?.absoluteString))")
  fields.append(contentsOf: reminderDateFields("dueDate", reminder.dueDateComponents))
  fields.append(contentsOf: reminderDateFields("startDate", distinctStartComponents(reminder)))
  fields.append("\"alerts\":\(reminderAlertsJSON(from: reminder))")
  fields.append("\"recurrence\":\(recurrenceToJSON(reminder.recurrenceRules))")
  if let created = reminder.creationDate {
    fields.append("\"created\":\(jsonString(formatDisplay(created)))")
  } else {
    fields.append("\"created\":null")
  }
  if let modified = reminder.lastModifiedDate {
    fields.append("\"lastModified\":\(jsonString(formatDisplay(modified)))")
  } else {
    fields.append("\"lastModified\":null")
  }
  return "{\(fields.joined(separator: ","))}"
}
func requireReminderList(store: EKEventStore, name: String) -> EKCalendar {
  let matched = store.calendars(for: .reminder).filter { $0.title == name }
  guard let list = matched.first else { exitWithError("Reminder list not found: \(name)") }
  return list
}
func requireReminder(store: EKEventStore, uid: String) -> EKReminder {
  let predicate = store.predicateForReminders(in: nil)
  let semaphore = DispatchSemaphore(value: 0)
  var found: EKReminder?
  store.fetchReminders(matching: predicate) { reminders in
    found = reminders?.first { $0.calendarItemIdentifier == uid }
    semaphore.signal()
  }
  semaphore.wait()
  guard let reminder = found else { exitWithError("Reminder not found: \(uid)") }
  return reminder
}
func fetchRemindersMatching(store: EKEventStore, predicate: NSPredicate) -> [EKReminder] {
  let semaphore = DispatchSemaphore(value: 0)
  var result: [EKReminder] = []
  store.fetchReminders(matching: predicate) { reminders in
    result = reminders ?? []
    semaphore.signal()
  }
  semaphore.wait()
  return result
}
func fetchRemindersSync(store: EKEventStore, calendars: [EKCalendar]?) -> [EKReminder] {
  fetchRemindersMatching(store: store, predicate: store.predicateForReminders(in: calendars))
}
func listReminderLists(store: EKEventStore) {
  let lists = store.calendars(for: .reminder)
  let items = lists.map { list -> String in
    "{\"name\":\(jsonString(list.title)),\"uid\":\(jsonString(list.calendarIdentifier))}"
  }
  print("[\(items.joined(separator: ","))]")
}
/// Open work first, soonest due first, undated last; completed tail newest-done first.
/// Alphabetical order buried today's deadline under whatever started with an A.
func sortedForList(_ reminders: [EKReminder]) -> [EKReminder] {
  reminders.sorted { a, b in
    if a.isCompleted != b.isCompleted { return !a.isCompleted }
    if a.isCompleted {
      let aDone = a.completionDate ?? .distantPast
      let bDone = b.completionDate ?? .distantPast
      if aDone != bDone { return aDone > bDone }
      return (a.title ?? "") < (b.title ?? "")
    }
    let aDue = a.dueDateComponents.flatMap(reminderComponentsDate)
    let bDue = b.dueDateComponents.flatMap(reminderComponentsDate)
    switch (aDue, bDue) {
    case let (x?, y?):
      if x != y { return x < y }
    case (nil, _?):
      return false
    case (_?, nil):
      return true
    case (nil, nil):
      break
    }
    return (a.title ?? "") < (b.title ?? "")
  }
}
/// A list payload states its own bounds: an agent that sees `truncated` knows to narrow the
/// question instead of trusting a clipped answer as the whole of it.
func printReminderList(_ reminders: [EKReminder], list: String, limit: Int?) {
  let shown = limit.map { Array(reminders.prefix($0)) } ?? reminders
  let fields = [
    "\"list\":\(jsonString(list))",
    "\"total\":\(reminders.count)",
    "\"returned\":\(shown.count)",
    "\"truncated\":\(shown.count < reminders.count)",
    "\"reminders\":[\(shown.map { reminderToJSON($0) }.joined(separator: ","))]",
  ]
  print("{\(fields.joined(separator: ","))}")
}
func listReminders(store: EKEventStore, listName: String, includeCompleted: Bool, limit: Int?) {
  let list = requireReminderList(store: store, name: listName)
  var reminders = fetchRemindersSync(store: store, calendars: [list])
  if !includeCompleted {
    reminders = reminders.filter { !$0.isCompleted }
  }
  printReminderList(sortedForList(reminders), list: list.title, limit: limit)
}
// Completed-in-range lives in EventKit's own predicate — no need to pull the whole
// completed backlog and filter here. Reminders whose client never stamped a completion
// date do not match, by design.
func listCompletedReminders(store: EKEventStore, listName: String, from: Date?, to: Date?, limit: Int?) {
  let list = requireReminderList(store: store, name: listName)
  let predicate = store.predicateForCompletedReminders(
    withCompletionDateStarting: from,
    ending: to,
    calendars: [list]
  )
  let reminders = fetchRemindersMatching(store: store, predicate: predicate).sorted {
    ($0.completionDate ?? .distantPast) > ($1.completionDate ?? .distantPast)
  }
  printReminderList(reminders, list: list.title, limit: limit)
}
func searchReminders(store: EKEventStore, query: String, listName: String, limit: Int?) {
  let list = requireReminderList(store: store, name: listName)
  let reminders = fetchRemindersSync(store: store, calendars: [list])
  let queryNorm = normalizeQuotes(query.lowercased())
  let matched = reminders.filter {
    normalizeQuotes(($0.title ?? "").lowercased()).contains(queryNorm)
  }
  printReminderList(sortedForList(matched), list: list.title, limit: limit)
}
func getReminderByUid(store: EKEventStore, uid: String) {
  print(reminderToJSON(requireReminder(store: store, uid: uid)))
}
/// Wall-clock in the display zone: a naive `--due` is the owner's local time, and an all-day
/// due keeps no clock at all rather than a phantom midnight.
func reminderComponents(from date: Date, allDay: Bool) -> DateComponents {
  var cal = Calendar.current
  cal.timeZone = displayTimeZone
  let units: Set<Calendar.Component> =
    allDay ? [.year, .month, .day] : [.year, .month, .day, .hour, .minute, .second]
  return cal.dateComponents(units, from: date)
}
func applyReminderURL(to reminder: EKReminder, url: String?, clearUrl: Bool) {
  if clearUrl {
    reminder.url = nil
  } else if let url {
    guard let parsed = URL(string: url) else { exitWithError("Invalid url: \(url)") }
    reminder.url = parsed
  }
}
func createReminder(
  store: EKEventStore,
  listName: String,
  title: String,
  notes: String?,
  due: Date?,
  dueAllDay: Bool,
  start: Date?,
  startAllDay: Bool,
  priority: Int?,
  url: String?,
  alertsJSON: String?,
  recurrenceJSON: String?
) {
  let list = requireReminderList(store: store, name: listName)
  let reminder = EKReminder(eventStore: store)
  reminder.calendar = list
  reminder.title = title
  if let notes { reminder.notes = notes }
  if let due { reminder.dueDateComponents = reminderComponents(from: due, allDay: dueAllDay) }
  if let start {
    reminder.startDateComponents = alignedStartComponents(
      from: start,
      requestedAllDay: startAllDay,
      due: reminder.dueDateComponents
    )
  }
  if let priority { reminder.priority = priority }
  applyReminderURL(to: reminder, url: url, clearUrl: false)
  if let recurrenceJSON { reminder.recurrenceRules = [parseRecurrenceRule(recurrenceJSON)] }
  applyReminderAlerts(to: reminder, alertsJSON: alertsJSON)
  do {
    try store.save(reminder, commit: true)
  } catch {
    exitWithError("Failed to create reminder: \(error.localizedDescription)")
  }
  print(reminderToJSON(reminder))
}
func updateReminder(
  store: EKEventStore,
  uid: String,
  title: String?,
  notes: String?,
  clearNotes: Bool,
  due: Date?,
  dueAllDay: Bool,
  clearDue: Bool,
  start: Date?,
  startAllDay: Bool,
  clearStart: Bool,
  priority: Int?,
  url: String?,
  clearUrl: Bool,
  alertsJSON: String?,
  clearAlerts: Bool,
  recurrenceJSON: String?,
  clearRecurrence: Bool
) {
  let reminder = requireReminder(store: store, uid: uid)
  if let title { reminder.title = title }
  if clearNotes {
    reminder.notes = nil
  } else if let notes {
    reminder.notes = notes
  }
  if clearDue {
    reminder.dueDateComponents = nil
  } else if let due {
    reminder.dueDateComponents = reminderComponents(from: due, allDay: dueAllDay)
  }
  if clearStart {
    reminder.startDateComponents = nil
  } else if let start {
    reminder.startDateComponents = alignedStartComponents(
      from: start,
      requestedAllDay: startAllDay,
      due: reminder.dueDateComponents
    )
  }
  if let priority { reminder.priority = priority }
  applyReminderURL(to: reminder, url: url, clearUrl: clearUrl)
  if clearRecurrence {
    reminder.recurrenceRules = nil
  } else if let recurrenceJSON {
    reminder.recurrenceRules = [parseRecurrenceRule(recurrenceJSON)]
  }
  if clearAlerts {
    reminder.alarms = nil
  } else {
    applyReminderAlerts(to: reminder, alertsJSON: alertsJSON)
  }
  do {
    try store.save(reminder, commit: true)
  } catch {
    exitWithError("Failed to update reminder: \(error.localizedDescription)")
  }
  print(reminderToJSON(reminder))
}
func setReminderCompleted(store: EKEventStore, uid: String, completed: Bool) {
  let reminder = requireReminder(store: store, uid: uid)
  reminder.isCompleted = completed
  if completed {
    reminder.completionDate = Date()
  } else {
    reminder.completionDate = nil
  }
  do {
    try store.save(reminder, commit: true)
  } catch {
    exitWithError("Failed to update reminder: \(error.localizedDescription)")
  }
  print(reminderToJSON(reminder))
}
func deleteReminder(store: EKEventStore, uid: String) {
  let reminder = requireReminder(store: store, uid: uid)
  let name = reminder.title ?? ""
  do {
    try store.remove(reminder, commit: true)
  } catch {
    exitWithError("Failed to delete reminder: \(error.localizedDescription)")
  }
  print("{\"deleted\":true,\"uid\":\(jsonString(uid)),\"name\":\(jsonString(name))}")
}

// MARK: - CLI

func printUsage() -> Never {
  fputs("""
  Usage: calendar-helper <command> [options]
  Calendar:
    list-calendars
    list-events --from <ISO> --to <ISO> [--calendar <name>]
    search-events --query <text> [--calendar <name>]
    get-event --uid <id>
    create-event --calendar <name> --title <text> --from <ISO> --to <ISO> [options]
    update-event --uid <id> [options]
    delete-event --uid <id>
  Reminders:
    list-reminder-lists
    list-reminders --list <name> [--include-completed true|false] [--limit <n>]
    list-completed-reminders --list <name> [--from <ISO>] [--to <ISO>] [--limit <n>]
    search-reminders --query <text> --list <name> [--limit <n>]
    get-reminder --uid <id>
    create-reminder --list <name> --title <text> [--notes] [--due] [--due-all-day]
      [--start] [--start-all-day] [--priority] [--url] [--alerts] [--recurrence]
    update-reminder --uid <id> [options]
    complete-reminder --uid <id>
    uncomplete-reminder --uid <id>
    delete-reminder --uid <id>
  """, stderr)
  exit(1)
}
func parseBoolArg(_ raw: String?) -> Bool? {
  guard let raw else { return nil }
  switch raw.lowercased() {
  case "true", "1", "yes": return true
  case "false", "0", "no": return false
  default: exitWithError("Invalid boolean: \(raw)")
  }
}
func parsePriorityArg(_ raw: String?) -> Int? {
  guard let raw else { return nil }
  guard let n = Int(raw) else { exitWithError("Invalid priority: \(raw)") }
  return n
}
func parseLimitArg(_ raw: String?) -> Int? {
  guard let raw else { return nil }
  guard let n = Int(raw), n > 0 else { exitWithError("Invalid limit: \(raw)") }
  return n
}
func parseReminderDateArg(_ raw: String?, flag: String) -> Date? {
  guard let raw else { return nil }
  guard let d = parseISO(raw) else { exitWithError("Invalid \(flag) date: \(raw)") }
  return d
}
func main() {
  let args = CommandLine.arguments
  guard args.count >= 2 else { printUsage() }
  let store = EKEventStore()
  let command = args[1]
  func getArg(_ flag: String) -> String? {
    guard let idx = args.firstIndex(of: flag), idx + 1 < args.count else { return nil }
    return args[idx + 1]
  }
  func hasFlag(_ flag: String) -> Bool {
    args.contains(flag)
  }

  if let displayTz = resolveTimeZoneId(getArg("--display-timezone")) {
    displayTimeZone = displayTz
  }

  let reminderCommands: Set<String> = [
    "list-reminder-lists", "list-reminders", "list-completed-reminders", "search-reminders",
    "get-reminder", "create-reminder", "update-reminder", "complete-reminder",
    "uncomplete-reminder", "delete-reminder",
  ]
  if reminderCommands.contains(command) {
    ensureReminderAccess(store: store)
  } else {
    ensureEventAccess(store: store)
  }

  switch command {
  case "list-calendars":
    listCalendars(store: store)
  case "list-events":
    guard let fromStr = getArg("--from"), let toStr = getArg("--to") else {
      exitWithError("list-events requires --from and --to ISO dates")
    }
    guard let fromDate = parseISO(fromStr) else { exitWithError("Invalid --from date: \(fromStr)") }
    guard let toDate = parseISO(toStr) else { exitWithError("Invalid --to date: \(toStr)") }
    listEvents(store: store, from: fromDate, to: toDate, calendarName: getArg("--calendar"))
  case "search-events":
    guard let query = getArg("--query") else { exitWithError("search-events requires --query") }
    searchEvents(store: store, query: query, calendarName: getArg("--calendar"))
  case "get-event":
    guard let uid = getArg("--uid") else { exitWithError("get-event requires --uid") }
    getEventByUid(store: store, uid: uid)
  case "create-event":
    guard let calendar = getArg("--calendar"), let title = getArg("--title"),
          let fromStr = getArg("--from"), let toStr = getArg("--to") else {
      exitWithError("create-event requires --calendar, --title, --from, and --to")
    }
    guard let fromDate = parseISO(fromStr) else { exitWithError("Invalid --from date: \(fromStr)") }
    guard let toDate = parseISO(toStr) else { exitWithError("Invalid --to date: \(toStr)") }
    createEvent(
      store: store,
      calendarName: calendar,
      title: title,
      from: fromDate,
      to: toDate,
      location: getArg("--location"),
      notes: getArg("--notes"),
      allDay: parseBoolArg(getArg("--all-day")),
      timeZoneId: getArg("--timezone"),
      url: getArg("--url"),
      alertsJSON: getArg("--alerts"),
      recurrenceJSON: getArg("--recurrence")
    )
  case "update-event":
    guard let uid = getArg("--uid") else { exitWithError("update-event requires --uid") }
    let fromStr = getArg("--from")
    let toStr = getArg("--to")
    let fromDate: Date? = {
      guard let fromStr else { return nil }
      guard let d = parseISO(fromStr) else { exitWithError("Invalid --from date: \(fromStr)") }
      return d
    }()
    let toDate: Date? = {
      guard let toStr else { return nil }
      guard let d = parseISO(toStr) else { exitWithError("Invalid --to date: \(toStr)") }
      return d
    }()
    updateEvent(
      store: store,
      uid: uid,
      title: getArg("--title"),
      from: fromDate,
      to: toDate,
      location: getArg("--location"),
      notes: getArg("--notes"),
      allDay: parseBoolArg(getArg("--all-day")),
      timeZoneId: getArg("--timezone"),
      clearLocation: hasFlag("--clear-location"),
      clearNotes: hasFlag("--clear-notes"),
      url: getArg("--url"),
      clearUrl: hasFlag("--clear-url"),
      alertsJSON: getArg("--alerts"),
      clearAlerts: hasFlag("--clear-alerts"),
      recurrenceJSON: getArg("--recurrence"),
      clearRecurrence: hasFlag("--clear-recurrence")
    )
  case "delete-event":
    guard let uid = getArg("--uid") else { exitWithError("delete-event requires --uid") }
    deleteEvent(store: store, uid: uid)

  case "list-reminder-lists":
    listReminderLists(store: store)
  case "list-reminders":
    guard let list = getArg("--list") else { exitWithError("list-reminders requires --list") }
    let include = parseBoolArg(getArg("--include-completed")) ?? false
    listReminders(store: store, listName: list, includeCompleted: include, limit: parseLimitArg(getArg("--limit")))
  case "list-completed-reminders":
    guard let list = getArg("--list") else { exitWithError("list-completed-reminders requires --list") }
    let from: Date? = {
      guard let raw = getArg("--from") else { return nil }
      guard let d = parseISO(raw) else { exitWithError("Invalid --from date: \(raw)") }
      return d
    }()
    let to: Date? = {
      guard let raw = getArg("--to") else { return nil }
      guard let d = parseISO(raw) else { exitWithError("Invalid --to date: \(raw)") }
      return d
    }()
    listCompletedReminders(
      store: store,
      listName: list,
      from: from,
      to: to,
      limit: parseLimitArg(getArg("--limit"))
    )
  case "search-reminders":
    guard let query = getArg("--query"), let list = getArg("--list") else {
      exitWithError("search-reminders requires --query and --list")
    }
    searchReminders(store: store, query: query, listName: list, limit: parseLimitArg(getArg("--limit")))
  case "get-reminder":
    guard let uid = getArg("--uid") else { exitWithError("get-reminder requires --uid") }
    getReminderByUid(store: store, uid: uid)
  case "create-reminder":
    guard let list = getArg("--list"), let title = getArg("--title") else {
      exitWithError("create-reminder requires --list and --title")
    }
    createReminder(
      store: store,
      listName: list,
      title: title,
      notes: getArg("--notes"),
      due: parseReminderDateArg(getArg("--due"), flag: "--due"),
      dueAllDay: hasFlag("--due-all-day"),
      start: parseReminderDateArg(getArg("--start"), flag: "--start"),
      startAllDay: hasFlag("--start-all-day"),
      priority: parsePriorityArg(getArg("--priority")),
      url: getArg("--url"),
      alertsJSON: getArg("--alerts"),
      recurrenceJSON: getArg("--recurrence")
    )
  case "update-reminder":
    guard let uid = getArg("--uid") else { exitWithError("update-reminder requires --uid") }
    updateReminder(
      store: store,
      uid: uid,
      title: getArg("--title"),
      notes: getArg("--notes"),
      clearNotes: hasFlag("--clear-notes"),
      due: parseReminderDateArg(getArg("--due"), flag: "--due"),
      dueAllDay: hasFlag("--due-all-day"),
      clearDue: hasFlag("--clear-due"),
      start: parseReminderDateArg(getArg("--start"), flag: "--start"),
      startAllDay: hasFlag("--start-all-day"),
      clearStart: hasFlag("--clear-start"),
      priority: parsePriorityArg(getArg("--priority")),
      url: getArg("--url"),
      clearUrl: hasFlag("--clear-url"),
      alertsJSON: getArg("--alerts"),
      clearAlerts: hasFlag("--clear-alerts"),
      recurrenceJSON: getArg("--recurrence"),
      clearRecurrence: hasFlag("--clear-recurrence")
    )
  case "complete-reminder":
    guard let uid = getArg("--uid") else { exitWithError("complete-reminder requires --uid") }
    setReminderCompleted(store: store, uid: uid, completed: true)
  case "uncomplete-reminder":
    guard let uid = getArg("--uid") else { exitWithError("uncomplete-reminder requires --uid") }
    setReminderCompleted(store: store, uid: uid, completed: false)
  case "delete-reminder":
    guard let uid = getArg("--uid") else { exitWithError("delete-reminder requires --uid") }
    deleteReminder(store: store, uid: uid)

  default:
    printUsage()
  }
}
main()
