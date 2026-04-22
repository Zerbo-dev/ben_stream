import 'package:flutter/material.dart';
import 'package:cached_network_image/cached_network_image.dart';
import '../models/anime.dart';
import '../services/anime_service.dart';
import 'detail_screen.dart';

class HomeScreen extends StatefulWidget {
  const HomeScreen({super.key});

  @override
  State<HomeScreen> createState() => _HomeScreenState();
}

class _HomeScreenState extends State<HomeScreen> {
  List<Anime> _all = [];
  List<Anime> _filtered = [];
  String _search = '';
  String _filterType = 'all';
  String _filterLang = 'all';
  String _filterEps = 'all';
  bool _loading = true;
  bool _showFilters = false;

  @override
  void initState() {
    super.initState();
    _load();
  }

  Future<void> _load() async {
    final animes = await AnimeService.loadAll();
    setState(() {
      _all = animes;
      _filtered = animes;
      _loading = false;
    });
  }

  void _applyFilters() {
    setState(() {
      _filtered = _all.where((a) {
        final matchSearch = _search.isEmpty ||
            a.name.toLowerCase().contains(_search.toLowerCase());
        final matchType = _filterType == 'all' ||
            (_filterType == 'films' && a.isMovie) ||
            (_filterType == 'series' && !a.isMovie);
        final matchLang =
            _filterLang == 'all' || a.availableLangs.contains(_filterLang);
        final eps = a.totalEpisodes;
        final matchEps = _filterEps == 'all' ||
            (_filterEps == '1-12' && eps >= 1 && eps <= 12) ||
            (_filterEps == '13-26' && eps >= 13 && eps <= 26) ||
            (_filterEps == '26+' && eps > 26) ||
            (_filterEps == 'film' && a.isMovie);
        return matchSearch && matchType && matchLang && matchEps;
      }).toList();
    });
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      body: Container(
        decoration: const BoxDecoration(
          gradient: LinearGradient(
            begin: Alignment.topLeft,
            end: Alignment.bottomRight,
            colors: [
              Color(0xFF0D0221),
              Color(0xFF1A0533),
              Color(0xFF0A1628),
              Color(0xFF110D2E),
            ],
            stops: [0.0, 0.3, 0.7, 1.0],
          ),
        ),
        child: SafeArea(
          child: Column(
            children: [
              _buildHeader(),
              if (_showFilters) _buildFilterPanel(),
              Expanded(
                child: _loading
                    ? const Center(
                        child:
                            CircularProgressIndicator(color: Color(0xFF7C3AED)))
                    : _filtered.isEmpty
                        ? const Center(
                            child: Text('Aucun résultat',
                                style: TextStyle(color: Colors.white54)))
                        : _buildMosaicGrid(),
              ),
            ],
          ),
        ),
      ),
    );
  }

  Widget _buildHeader() {
    return Padding(
      padding: const EdgeInsets.fromLTRB(16, 12, 16, 8),
      child: Column(
        children: [
          Row(
            children: [
              ShaderMask(
                shaderCallback: (b) => const LinearGradient(
                  colors: [Color(0xFF7C3AED), Color(0xFF3B82F6)],
                ).createShader(b),
                child: const Text('BenStream',
                    style: TextStyle(
                        fontSize: 24,
                        fontWeight: FontWeight.w900,
                        color: Colors.white,
                        letterSpacing: 2)),
              ),
              const Spacer(),
              GestureDetector(
                onTap: () => setState(() => _showFilters = !_showFilters),
                child: Container(
                  padding:
                      const EdgeInsets.symmetric(horizontal: 12, vertical: 6),
                  decoration: BoxDecoration(
                    color: _showFilters
                        ? const Color(0xFF7C3AED)
                        : Colors.white.withValues(alpha: 0.1),
                    borderRadius: BorderRadius.circular(20),
                    border: Border.all(
                        color: const Color(0xFF7C3AED).withValues(alpha: 0.5)),
                  ),
                  child: Row(
                    children: const [
                      Icon(Icons.tune, color: Colors.white, size: 16),
                      SizedBox(width: 4),
                      Text('Filtres',
                          style: TextStyle(color: Colors.white, fontSize: 13)),
                    ],
                  ),
                ),
              ),
            ],
          ),
          const SizedBox(height: 10),
          Container(
            decoration: BoxDecoration(
              color: Colors.white.withValues(alpha: 0.08),
              borderRadius: BorderRadius.circular(14),
              border: Border.all(color: Colors.white.withValues(alpha: 0.12)),
            ),
            child: TextField(
              onChanged: (v) {
                _search = v;
                _applyFilters();
              },
              style: const TextStyle(color: Colors.white),
              decoration: const InputDecoration(
                hintText: 'Rechercher...',
                hintStyle: TextStyle(color: Colors.white38),
                prefixIcon: Icon(Icons.search, color: Colors.white38),
                border: InputBorder.none,
                contentPadding: EdgeInsets.symmetric(vertical: 14),
              ),
            ),
          ),
          const SizedBox(height: 8),
          Align(
            alignment: Alignment.centerLeft,
            child: Text('${_filtered.length} titres',
                style: const TextStyle(color: Colors.white38, fontSize: 12)),
          ),
        ],
      ),
    );
  }

  Widget _buildFilterPanel() {
    return Container(
      margin: const EdgeInsets.fromLTRB(16, 0, 16, 8),
      padding: const EdgeInsets.all(14),
      decoration: BoxDecoration(
        color: Colors.white.withValues(alpha: 0.06),
        borderRadius: BorderRadius.circular(16),
        border: Border.all(color: Colors.white.withValues(alpha: 0.1)),
      ),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          _filterRow(
              'Type',
              ['all', 'series', 'films'],
              ['Tout', 'Séries', 'Films'],
              _filterType,
              (v) => setState(() {
                    _filterType = v;
                    _applyFilters();
                  })),
          const SizedBox(height: 10),
          _filterRow(
              'Langue',
              ['all', 'vf', 'vostfr'],
              ['Tout', 'VF', 'VOSTFR'],
              _filterLang,
              (v) => setState(() {
                    _filterLang = v;
                    _applyFilters();
                  })),
          const SizedBox(height: 10),
          _filterRow(
              'Épisodes',
              ['all', '1-12', '13-26', '26+'],
              ['Tout', '1-12', '13-26', '26+'],
              _filterEps,
              (v) => setState(() {
                    _filterEps = v;
                    _applyFilters();
                  })),
        ],
      ),
    );
  }

  Widget _filterRow(String label, List<String> values, List<String> labels,
      String current, Function(String) onTap) {
    return Row(
      children: [
        SizedBox(
            width: 70,
            child: Text(label,
                style: const TextStyle(color: Colors.white54, fontSize: 12))),
        Expanded(
          child: SingleChildScrollView(
            scrollDirection: Axis.horizontal,
            child: Row(
              children: List.generate(values.length, (i) {
                final active = current == values[i];
                return GestureDetector(
                  onTap: () => onTap(values[i]),
                  child: Container(
                    margin: const EdgeInsets.only(right: 6),
                    padding:
                        const EdgeInsets.symmetric(horizontal: 12, vertical: 5),
                    decoration: BoxDecoration(
                      color: active
                          ? const Color(0xFF7C3AED)
                          : Colors.white.withValues(alpha: 0.08),
                      borderRadius: BorderRadius.circular(20),
                    ),
                    child: Text(labels[i],
                        style: TextStyle(
                            color: active ? Colors.white : Colors.white54,
                            fontSize: 12,
                            fontWeight:
                                active ? FontWeight.bold : FontWeight.normal)),
                  ),
                );
              }),
            ),
          ),
        ),
      ],
    );
  }

  Widget _buildMosaicGrid() {
    return GridView.builder(
      padding: const EdgeInsets.fromLTRB(12, 4, 12, 20),
      gridDelegate: const SliverGridDelegateWithFixedCrossAxisCount(
        crossAxisCount: 3,
        childAspectRatio: 0.6,
        crossAxisSpacing: 8,
        mainAxisSpacing: 8,
      ),
      itemCount: _filtered.length,
      itemBuilder: (context, index) => _buildCard(_filtered[index]),
    );
  }

  Widget _buildCard(Anime anime) {
    return GestureDetector(
      onTap: () => Navigator.push(context,
          MaterialPageRoute(builder: (_) => DetailScreen(anime: anime))),
      child: Container(
        decoration: BoxDecoration(
          borderRadius: BorderRadius.circular(12),
          boxShadow: [
            BoxShadow(
                color: const Color(0xFF7C3AED).withValues(alpha: 0.2),
                blurRadius: 8,
                offset: const Offset(0, 4))
          ],
        ),
        child: ClipRRect(
          borderRadius: BorderRadius.circular(12),
          child: Stack(
            fit: StackFit.expand,
            children: [
              CachedNetworkImage(
                imageUrl: anime.cover,
                fit: BoxFit.cover,
                placeholder: (_, __) => Container(
                  decoration: BoxDecoration(
                    gradient: LinearGradient(colors: [
                      const Color(0xFF7C3AED).withValues(alpha: 0.3),
                      const Color(0xFF3B82F6).withValues(alpha: 0.3),
                    ]),
                  ),
                ),
                errorWidget: (_, __, ___) => Container(
                    color: const Color(0xFF1A0533),
                    child:
                        const Icon(Icons.broken_image, color: Colors.white30)),
              ),
              Positioned(
                bottom: 0,
                left: 0,
                right: 0,
                child: Container(
                  height: 80,
                  decoration: const BoxDecoration(
                    gradient: LinearGradient(
                      begin: Alignment.bottomCenter,
                      end: Alignment.topCenter,
                      colors: [Colors.black87, Colors.transparent],
                    ),
                  ),
                ),
              ),
              Positioned(
                bottom: 6,
                left: 6,
                right: 6,
                child: Text(anime.name,
                    style: const TextStyle(
                        color: Colors.white,
                        fontSize: 11,
                        fontWeight: FontWeight.w600,
                        shadows: [Shadow(color: Colors.black, blurRadius: 4)]),
                    maxLines: 2,
                    overflow: TextOverflow.ellipsis),
              ),
              Positioned(
                top: 6,
                right: 6,
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.end,
                  children: anime.availableLangs
                      .map((l) => Container(
                            margin: const EdgeInsets.only(bottom: 3),
                            padding: const EdgeInsets.symmetric(
                                horizontal: 5, vertical: 2),
                            decoration: BoxDecoration(
                              color: l == 'vf'
                                  ? const Color(0xFF7C3AED)
                                      .withValues(alpha: 0.9)
                                  : const Color(0xFF3B82F6)
                                      .withValues(alpha: 0.9),
                              borderRadius: BorderRadius.circular(4),
                            ),
                            child: Text(l.toUpperCase(),
                                style: const TextStyle(
                                    color: Colors.white,
                                    fontSize: 8,
                                    fontWeight: FontWeight.bold)),
                          ))
                      .toList(),
                ),
              ),
              if (anime.isMovie)
                Positioned(
                  top: 6,
                  left: 6,
                  child: Container(
                    padding:
                        const EdgeInsets.symmetric(horizontal: 5, vertical: 2),
                    decoration: BoxDecoration(
                        color: Colors.amber.withValues(alpha: 0.9),
                        borderRadius: BorderRadius.circular(4)),
                    child: const Text('FILM',
                        style: TextStyle(
                            color: Colors.black,
                            fontSize: 8,
                            fontWeight: FontWeight.bold)),
                  ),
                ),
            ],
          ),
        ),
      ),
    );
  }
}
