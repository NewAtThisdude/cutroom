// The font families installed on this Mac (Core Text), as a JSON list. Hidden system families (".SF NS") are left out.
import CoreText
import Foundation

let names = (CTFontManagerCopyAvailableFontFamilyNames() as? [String] ?? []).filter { !$0.hasPrefix(".") }
let data = try! JSONSerialization.data(withJSONObject: names.sorted { $0.localizedCaseInsensitiveCompare($1) == .orderedAscending })
FileHandle.standardOutput.write(data)
