import 'package:flutter/material.dart';
import 'package:cached_network_image/cached_network_image.dart';
import '../models/anime.dart';
import '../services/progress_service.dart';
import 'player_screen.dart';

class DetailScreen extends StatefulWidget {
  final Anime anime;
  const DetailScreen({super.key, required this.anime});

  @override
  State<DetailScreen> createState() => _DetailScreenState();
}

class _DetailScreenState extends State<DetailScreen> {
  late String _selectedLang;
  Map<String, int> _progress = {};
  final Map<String, bool> _expanded = {};

  @override
  void initState() {
    super.initState();
    final langs = widget.anime.availableLangs;
    _selectedLang = langs.contains('vf') ? 'vf' : (langs.isNotEmpty ? langs.first : 'vf');
    _loadProgress();
  }

  Future<void> _loadProgress() async {
    final p = await ProgressService.loadAll(widget.anime.fileId);
    setState(() => _progress = p);
  }

  Language? get _lang => widget.anime.langues[_selectedLang];

  int _getProgress(String section) =>
      _progress['${widget.anime.fileId}|$_selectedLang|$section'] ?? 0;

  bool _isExpanded(String key) => _expanded[key] ?? false;

  void _toggleExpand(String key) => setState(() => _expanded[key] = !_isExpanded(key));

  void _openPlayer(List<String> urls, String section, int startIndex) async {
    await Navigator.push(context, MaterialPageRoute(
      builder: (_) => PlayerScreen(
        anime: widget.anime,
        langue: _selectedLang,
        section: section,
        urls: urls,
        startIndex: startIndex,
      ),
    ));
    _loadProgress();
  }

  @override
  Widget build(BuildContext context) {
    final lang = _lang;
    final availableLangs = widget.anime.availableLangs;

    return Scaffold(
      body: Container(
        decoration: const BoxDecoration(
          gradient: LinearGradient(
            begin: Alignment.topLeft,
            end: Alignment.bottomRight,
            colors: [Color(0xFF0D0221), Color(0xFF1A0533), Color(0xFF0A1628), Color(0xFF110D2E)],
            stops: [0.0, 0.3, 0.7, 1.0],
          ),
        ),
        child: SafeArea(
          child: CustomScrollView(
            slivers: [
              // Header avec cover
              SliverToBoxAdapter(child: _buildHero()),

              SliverToBoxAdapter(
                child: Padding(
                  padding: const EdgeInsets.all(16),
                  child: Column(
                    crossAxisAlignment: CrossAxisAlignment.start,
                    children: [
                      // Titre
                      Text(widget.anime.name,
                          style: const TextStyle(color: Colors.white, fontSize: 22, fontWeight: FontWeight.bold)),
                      const SizedBox(height: 4),
                      if (!widget.anime.isMovie && widget.anime.totalEpisodes > 0)
                        Text('${widget.anime.totalEpisodes} épisodes',
                            style: const TextStyle(color: Color(0xFF7C3AED), fontSize: 14)),
                      const SizedBox(height: 16),

                      // Sélecteur langue
                      if (availableLangs.length > 1) ...[
                        const Text('LANGUE', style: TextStyle(color: Colors.white38, fontSize: 11, letterSpacing: 1.5)),
                        const SizedBox(height: 8),
                        Row(
                          children: availableLangs.map((l) {
                            final active = _selectedLang == l;
                            return GestureDetector(
                              onTap: () => setState(() => _selectedLang = l),
                              child: Container(
                                margin: const EdgeInsets.only(right: 8),
                                padding: const EdgeInsets.symmetric(horizontal: 20, vertical: 8),
                                decoration: BoxDecoration(
                                  color: active ? const Color(0xFF7C3AED) : Colors.white.withValues(alpha: 0.08),
                                  borderRadius: BorderRadius.circular(8),
                                  border: Border.all(
                                      color: active ? const Color(0xFF7C3AED) : Colors.white.withValues(alpha: 0.1)),
                                ),
                                child: Text(l.toUpperCase(),
                                    style: TextStyle(
                                        color: active ? Colors.white : Colors.white54,
                                        fontWeight: FontWeight.bold)),
                              ),
                            );
                          }).toList(),
                        ),
                        const SizedBox(height: 20),
                      ],

                      // Contenu
                      if (lang == null || !lang.hasContent)
                        const Center(
                          child: Padding(
                            padding: EdgeInsets.all(32),
                            child: Text('Aucun contenu disponible',
                                style: TextStyle(color: Colors.white38)),
                          ),
                        )
                      else ...[
                        // Films
                        if (lang.films.isNotEmpty)
                          _buildAccordion('Films', 'films', lang.films, Icons.movie),

                        // Saisons
                        ...lang.saisons.entries.map((e) =>
                          _buildAccordion(
                            e.key.replaceAll('saison', 'Saison '),
                            e.key,
                            e.value,
                            Icons.play_circle,
                          ),
                        ),

                        // OAV
                        if (lang.oav.isNotEmpty)
                          _buildAccordion('OAV', 'oav', lang.oav, Icons.star),
                      ],
                    ],
                  ),
                ),
              ),
            ],
          ),
        ),
      ),
    );
  }

  Widget _buildHero() {
    return Stack(
      children: [
        // Cover en bannière
        SizedBox(
          height: 260,
          width: double.infinity,
          child: CachedNetworkImage(
            imageUrl: widget.anime.cover,
            fit: BoxFit.cover,
            errorWidget: (_, __, ___) => Container(color: const Color(0xFF1A0533)),
          ),
        ),
        // Gradient
        Positioned.fill(
          child: Container(
            decoration: const BoxDecoration(
              gradient: LinearGradient(
                begin: Alignment.topCenter,
                end: Alignment.bottomCenter,
                colors: [Colors.black38, Colors.transparent, Color(0xFF0D0221)],
                stops: [0.0, 0.5, 1.0],
              ),
            ),
          ),
        ),
        // Bouton retour
        Positioned(
          top: 12, left: 12,
          child: GestureDetector(
            onTap: () => Navigator.pop(context),
            child: Container(
              padding: const EdgeInsets.all(8),
              decoration: BoxDecoration(
                color: Colors.black54,
                borderRadius: BorderRadius.circular(10),
              ),
              child: const Icon(Icons.arrow_back, color: Colors.white, size: 20),
            ),
          ),
        ),
      ],
    );
  }

  Widget _buildAccordion(String title, String section, List<String> urls, IconData icon) {
    final expanded = _isExpanded(section);
    final progress = _getProgress(section);

    return Container(
      margin: const EdgeInsets.only(bottom: 10),
      decoration: BoxDecoration(
        color: Colors.white.withValues(alpha: 0.05),
        borderRadius: BorderRadius.circular(14),
        border: Border.all(color: Colors.white.withValues(alpha: 0.08)),
      ),
      child: Column(
        children: [
          // En-tête cliquable
          GestureDetector(
            onTap: () => _toggleExpand(section),
            child: Container(
              padding: const EdgeInsets.symmetric(horizontal: 16, vertical: 14),
              child: Row(
                children: [
                  Icon(icon, color: const Color(0xFF7C3AED), size: 20),
                  const SizedBox(width: 10),
                  Expanded(
                    child: Column(
                      crossAxisAlignment: CrossAxisAlignment.start,
                      children: [
                        Text(title,
                            style: const TextStyle(color: Colors.white, fontSize: 15, fontWeight: FontWeight.bold)),
                        Text('${urls.length} épisode${urls.length > 1 ? 's' : ''}',
                            style: const TextStyle(color: Colors.white38, fontSize: 12)),
                      ],
                    ),
                  ),
                  // Bouton continuer
                  if (progress > 0 && progress < urls.length)
                    GestureDetector(
                      onTap: () => _openPlayer(urls, section, progress),
                      child: Container(
                        margin: const EdgeInsets.only(right: 8),
                        padding: const EdgeInsets.symmetric(horizontal: 10, vertical: 5),
                        decoration: BoxDecoration(
                          color: const Color(0xFF7C3AED),
                          borderRadius: BorderRadius.circular(8),
                        ),
                        child: Row(
                          children: [
                            const Icon(Icons.play_arrow, color: Colors.white, size: 14),
                            const SizedBox(width: 3),
                            Text('Ep ${progress + 1}',
                                style: const TextStyle(color: Colors.white, fontSize: 11, fontWeight: FontWeight.bold)),
                          ],
                        ),
                      ),
                    ),
                  Icon(
                    expanded ? Icons.keyboard_arrow_up : Icons.keyboard_arrow_down,
                    color: Colors.white54,
                  ),
                ],
              ),
            ),
          ),

          // Liste épisodes déroulable
          if (expanded)
            Container(
              decoration: BoxDecoration(
                border: Border(top: BorderSide(color: Colors.white.withValues(alpha: 0.06))),
              ),
              child: ListView.builder(
                shrinkWrap: true,
                physics: const NeverScrollableScrollPhysics(),
                itemCount: urls.length,
                itemBuilder: (_, i) {
                  final watched = i < progress;
                  final current = i == progress;
                  final label = section == 'films'
                      ? 'Film ${i + 1}'
                      : section == 'oav'
                          ? 'OAV ${i + 1}'
                          : 'Épisode ${i + 1}';

                  return GestureDetector(
                    onTap: () => _openPlayer(urls, section, i),
                    child: Container(
                      padding: const EdgeInsets.symmetric(horizontal: 16, vertical: 10),
                      decoration: BoxDecoration(
                        color: current
                            ? const Color(0xFF7C3AED).withValues(alpha: 0.15)
                            : Colors.transparent,
                        border: Border(
                          bottom: BorderSide(color: Colors.white.withValues(alpha: 0.04)),
                        ),
                      ),
                      child: Row(
                        children: [
                          Container(
                            width: 32, height: 32,
                            decoration: BoxDecoration(
                              color: current
                                  ? const Color(0xFF7C3AED)
                                  : watched
                                      ? Colors.white.withValues(alpha: 0.05)
                                      : Colors.white.withValues(alpha: 0.08),
                              borderRadius: BorderRadius.circular(8),
                            ),
                            child: Icon(
                              current ? Icons.play_arrow : watched ? Icons.check : Icons.play_arrow,
                              color: watched && !current ? Colors.white24 : Colors.white,
                              size: 16,
                            ),
                          ),
                          const SizedBox(width: 12),
                          Text(label,
                              style: TextStyle(
                                color: watched && !current ? Colors.white38 : Colors.white,
                                fontSize: 14,
                              )),
                          if (current) ...[
                            const Spacer(),
                            const Text('EN COURS',
                                style: TextStyle(color: Color(0xFF7C3AED), fontSize: 10, fontWeight: FontWeight.bold)),
                          ],
                        ],
                      ),
                    ),
                  );
                },
              ),
            ),
        ],
      ),
    );
  }
}
