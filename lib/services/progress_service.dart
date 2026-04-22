import 'package:shared_preferences/shared_preferences.dart';

/// Sauvegarde localement : dernier épisode regardé par anime/langue/saison
class ProgressService {
  static Future<void> save({
    required String animeId,
    required String langue,
    required String section, // 'saison1', 'films', 'oav'
    required int episodeIndex,
  }) async {
    final prefs = await SharedPreferences.getInstance();
    await prefs.setInt('$animeId|$langue|$section', episodeIndex);
  }

  static Future<int> load({
    required String animeId,
    required String langue,
    required String section,
  }) async {
    final prefs = await SharedPreferences.getInstance();
    return prefs.getInt('$animeId|$langue|$section') ?? 0;
  }

  static Future<Map<String, int>> loadAll(String animeId) async {
    final prefs = await SharedPreferences.getInstance();
    final result = <String, int>{};
    for (final key in prefs.getKeys()) {
      if (key.startsWith('$animeId|')) {
        result[key] = prefs.getInt(key) ?? 0;
      }
    }
    return result;
  }
}
