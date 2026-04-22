import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:webview_flutter/webview_flutter.dart';
import '../models/anime.dart';
import '../services/progress_service.dart';

class PlayerScreen extends StatefulWidget {
  final Anime anime;
  final String langue;
  final String section;
  final List<String> urls;
  final int startIndex;

  const PlayerScreen({
    super.key,
    required this.anime,
    required this.langue,
    required this.section,
    required this.urls,
    required this.startIndex,
  });

  @override
  State<PlayerScreen> createState() => _PlayerScreenState();
}

class _PlayerScreenState extends State<PlayerScreen> {
  late int _currentIndex;
  late WebViewController _controller;
  bool _loading = true;

  @override
  void initState() {
    super.initState();
    _currentIndex = widget.startIndex;
    SystemChrome.setPreferredOrientations([
      DeviceOrientation.landscapeLeft,
      DeviceOrientation.landscapeRight,
      DeviceOrientation.portraitUp,
    ]);
    _initController();
  }

  @override
  void dispose() {
    SystemChrome.setPreferredOrientations([DeviceOrientation.portraitUp]);
    super.dispose();
  }

  void _initController() {
    _controller = WebViewController()
      ..setJavaScriptMode(JavaScriptMode.unrestricted)
      ..setNavigationDelegate(NavigationDelegate(
        onPageStarted: (_) => setState(() => _loading = true),
        onPageFinished: (_) => setState(() => _loading = false),
      ))
      ..loadRequest(Uri.parse(widget.urls[_currentIndex]));
  }

  void _goTo(int index) {
    if (index < 0 || index >= widget.urls.length) return;
    setState(() { _currentIndex = index; _loading = true; });
    _controller.loadRequest(Uri.parse(widget.urls[index]));
    _saveProgress(index);
  }

  Future<void> _saveProgress(int index) async {
    await ProgressService.save(
      animeId: widget.anime.fileId,
      langue: widget.langue,
      section: widget.section,
      episodeIndex: index,
    );
  }

  String get _label {
    if (widget.section == 'films') return 'Film ${_currentIndex + 1}';
    if (widget.section == 'oav') return 'OAV ${_currentIndex + 1}';
    final s = widget.section.replaceAll('saison', 'S');
    return '$s · Épisode ${_currentIndex + 1}';
  }

  @override
  Widget build(BuildContext context) {
    final isLandscape = MediaQuery.of(context).orientation == Orientation.landscape;

    return Scaffold(
      backgroundColor: Colors.black,
      body: SafeArea(
        child: isLandscape ? _buildLandscape() : _buildPortrait(),
      ),
    );
  }

  // Mode portrait : WebView en haut, contrôles en bas
  Widget _buildPortrait() {
    return Column(
      children: [
        // WebView zone — 40% de l'écran
        AspectRatio(
          aspectRatio: 16 / 9,
          child: _buildWebView(),
        ),

        // Zone contrôles
        Expanded(
          child: Container(
            color: const Color(0xFF0D0221),
            child: Column(
              children: [
                // Titre
                Padding(
                  padding: const EdgeInsets.fromLTRB(16, 16, 16, 8),
                  child: Column(
                    crossAxisAlignment: CrossAxisAlignment.start,
                    children: [
                      Text(widget.anime.name,
                          style: const TextStyle(color: Colors.white, fontSize: 16, fontWeight: FontWeight.bold),
                          overflow: TextOverflow.ellipsis),
                      const SizedBox(height: 4),
                      Text(_label, style: const TextStyle(color: Color(0xFF7C3AED), fontSize: 13)),
                    ],
                  ),
                ),

                const Divider(color: Colors.white12, height: 1),

                // Contrôles de navigation
                Padding(
                  padding: const EdgeInsets.symmetric(vertical: 16),
                  child: Row(
                    mainAxisAlignment: MainAxisAlignment.spaceEvenly,
                    children: [
                      // Précédent
                      _navButton(
                        icon: Icons.skip_previous_rounded,
                        label: 'Précédent',
                        enabled: _currentIndex > 0,
                        onTap: () => _goTo(_currentIndex - 1),
                      ),
                      // Reload
                      _navButton(
                        icon: Icons.refresh_rounded,
                        label: 'Recharger',
                        enabled: true,
                        onTap: () => _controller.reload(),
                        accent: false,
                      ),
                      // Suivant
                      _navButton(
                        icon: Icons.skip_next_rounded,
                        label: 'Suivant',
                        enabled: _currentIndex < widget.urls.length - 1,
                        onTap: () => _goTo(_currentIndex + 1),
                      ),
                    ],
                  ),
                ),

                // Compteur
                Text(
                  '${_currentIndex + 1} / ${widget.urls.length}',
                  style: const TextStyle(color: Colors.white38, fontSize: 13),
                ),

                const SizedBox(height: 12),
                const Divider(color: Colors.white12, height: 1),

                // Liste épisodes
                Expanded(child: _buildEpisodeList()),

                // Bouton retour
                Padding(
                  padding: const EdgeInsets.all(12),
                  child: GestureDetector(
                    onTap: () => Navigator.pop(context),
                    child: Container(
                      padding: const EdgeInsets.symmetric(vertical: 12),
                      decoration: BoxDecoration(
                        color: Colors.white.withValues(alpha: 0.08),
                        borderRadius: BorderRadius.circular(10),
                        border: Border.all(color: Colors.white.withValues(alpha: 0.1)),
                      ),
                      child: const Row(
                        mainAxisAlignment: MainAxisAlignment.center,
                        children: [
                          Icon(Icons.arrow_back, color: Colors.white54, size: 18),
                          SizedBox(width: 8),
                          Text('Retour', style: TextStyle(color: Colors.white54, fontSize: 14)),
                        ],
                      ),
                    ),
                  ),
                ),
              ],
            ),
          ),
        ),
      ],
    );
  }

  // Mode paysage : WebView plein écran avec overlay minimal
  Widget _buildLandscape() {
    return Stack(
      children: [
        Positioned.fill(child: _buildWebView()),
        // Bouton retour discret
        Positioned(
          top: 8, left: 8,
          child: GestureDetector(
            onTap: () => Navigator.pop(context),
            child: Container(
              padding: const EdgeInsets.all(8),
              decoration: BoxDecoration(
                color: Colors.black54,
                borderRadius: BorderRadius.circular(8),
              ),
              child: const Icon(Icons.arrow_back, color: Colors.white, size: 20),
            ),
          ),
        ),
        // Contrôles prev/next discrets
        Positioned(
          bottom: 8, right: 8,
          child: Row(
            children: [
              if (_currentIndex > 0)
                _overlayButton(Icons.skip_previous_rounded, () => _goTo(_currentIndex - 1)),
              const SizedBox(width: 8),
              _overlayButton(Icons.refresh_rounded, () => _controller.reload()),
              const SizedBox(width: 8),
              if (_currentIndex < widget.urls.length - 1)
                _overlayButton(Icons.skip_next_rounded, () => _goTo(_currentIndex + 1)),
            ],
          ),
        ),
        // Label épisode
        Positioned(
          bottom: 8, left: 8,
          child: Container(
            padding: const EdgeInsets.symmetric(horizontal: 10, vertical: 5),
            decoration: BoxDecoration(
              color: Colors.black54,
              borderRadius: BorderRadius.circular(8),
            ),
            child: Text(_label, style: const TextStyle(color: Colors.white70, fontSize: 12)),
          ),
        ),
      ],
    );
  }

  Widget _buildWebView() {
    return Stack(
      children: [
        WebViewWidget(controller: _controller),
        if (_loading)
          Container(
            color: Colors.black,
            child: const Center(child: CircularProgressIndicator(color: Color(0xFF7C3AED))),
          ),
      ],
    );
  }

  Widget _navButton({
    required IconData icon,
    required String label,
    required bool enabled,
    required VoidCallback onTap,
    bool accent = true,
  }) {
    return GestureDetector(
      onTap: enabled ? onTap : null,
      child: Column(
        children: [
          Container(
            width: 56, height: 56,
            decoration: BoxDecoration(
              color: !enabled
                  ? Colors.white.withValues(alpha: 0.05)
                  : accent
                      ? const Color(0xFF7C3AED).withValues(alpha: 0.2)
                      : Colors.white.withValues(alpha: 0.1),
              borderRadius: BorderRadius.circular(16),
              border: Border.all(
                color: !enabled
                    ? Colors.transparent
                    : accent
                        ? const Color(0xFF7C3AED).withValues(alpha: 0.4)
                        : Colors.white.withValues(alpha: 0.15),
              ),
            ),
            child: Icon(icon,
                color: !enabled ? Colors.white12 : accent ? const Color(0xFF7C3AED) : Colors.white70,
                size: 28),
          ),
          const SizedBox(height: 5),
          Text(label, style: TextStyle(color: enabled ? Colors.white38 : Colors.white12, fontSize: 11)),
        ],
      ),
    );
  }

  Widget _overlayButton(IconData icon, VoidCallback onTap) {
    return GestureDetector(
      onTap: onTap,
      child: Container(
        padding: const EdgeInsets.all(8),
        decoration: BoxDecoration(color: Colors.black54, borderRadius: BorderRadius.circular(8)),
        child: Icon(icon, color: Colors.white, size: 22),
      ),
    );
  }

  Widget _buildEpisodeList() {
    return ListView.builder(
      itemCount: widget.urls.length,
      itemBuilder: (_, i) {
        final current = i == _currentIndex;
        final watched = i < _currentIndex;
        final label = widget.section == 'films'
            ? 'Film ${i + 1}'
            : widget.section == 'oav'
                ? 'OAV ${i + 1}'
                : 'Épisode ${i + 1}';

        return GestureDetector(
          onTap: () => _goTo(i),
          child: Container(
            padding: const EdgeInsets.symmetric(horizontal: 16, vertical: 10),
            decoration: BoxDecoration(
              color: current ? const Color(0xFF7C3AED).withValues(alpha: 0.15) : Colors.transparent,
              border: Border(bottom: BorderSide(color: Colors.white.withValues(alpha: 0.04))),
            ),
            child: Row(
              children: [
                Icon(
                  current ? Icons.play_arrow : watched ? Icons.check_circle_outline : Icons.radio_button_unchecked,
                  color: current ? const Color(0xFF7C3AED) : watched ? Colors.white24 : Colors.white38,
                  size: 18,
                ),
                const SizedBox(width: 12),
                Text(label,
                    style: TextStyle(
                      color: current ? Colors.white : watched ? Colors.white38 : Colors.white70,
                      fontSize: 13,
                      fontWeight: current ? FontWeight.bold : FontWeight.normal,
                    )),
                if (current) ...[
                  const Spacer(),
                  const Text('▶', style: TextStyle(color: Color(0xFF7C3AED), fontSize: 12)),
                ],
              ],
            ),
          ),
        );
      },
    );
  }
}
