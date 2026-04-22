class Anime {
  final String fileId;
  final String name;
  final String cover;
  final Map<String, Language> langues;

  Anime({
    required this.fileId,
    required this.name,
    required this.cover,
    required this.langues,
  });

  bool get isMovie {
    bool hasEpisodes = false;
    bool hasFilms = false;
    for (final lang in langues.values) {
      if (lang.saisons.isNotEmpty || lang.oav.isNotEmpty) hasEpisodes = true;
      if (lang.films.isNotEmpty) hasFilms = true;
    }
    return hasFilms && !hasEpisodes;
  }

  int get totalEpisodes {
    int max = 0;
    for (final lang in langues.values) {
      int count = 0;
      for (final eps in lang.saisons.values) count += eps.length;
      count += lang.oav.length;
      if (count > max) max = count;
    }
    return max;
  }

  List<String> get availableLangs =>
      langues.entries.where((e) => e.value.hasContent).map((e) => e.key).toList();

  factory Anime.fromJson(String fileId, Map<String, dynamic> json) {
    final languesRaw = json['langues'] as Map<String, dynamic>? ?? {};
    final langues = languesRaw.map(
      (key, val) => MapEntry(key, Language.fromJson(val as Map<String, dynamic>)),
    );
    return Anime(
      fileId: fileId,
      name: json['name'] ?? '',
      cover: json['cover'] ?? '',
      langues: langues,
    );
  }
}

class Language {
  final Map<String, List<String>> saisons;
  final List<String> films;
  final List<String> oav;

  Language({required this.saisons, required this.films, required this.oav});

  bool get hasContent => saisons.isNotEmpty || films.isNotEmpty || oav.isNotEmpty;

  factory Language.fromJson(Map<String, dynamic> json) {
    final saisons = <String, List<String>>{};
    final raw = json['saisons'] as Map<String, dynamic>? ?? {};
    raw.forEach((key, val) {
      if (val is List) saisons[key] = val.map((e) => e.toString()).toList();
    });

    List<String> toList(dynamic v) =>
        v is List ? v.map((e) => e.toString()).toList() : [];

    return Language(
      saisons: saisons,
      films: toList(json['films']),
      oav: toList(json['oav']),
    );
  }
}
