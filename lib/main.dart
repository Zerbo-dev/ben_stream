import 'package:flutter/material.dart';
import 'screens/home_screen.dart';

void main() {
  runApp(const AnimeBoxApp());
}

class AnimeBoxApp extends StatelessWidget {
  const AnimeBoxApp({super.key});

  @override
  Widget build(BuildContext context) {
    return MaterialApp(
      title: 'Anime BOX',
      debugShowCheckedModeBanner: false,
      theme: ThemeData(
        colorScheme: ColorScheme.fromSeed(
          seedColor: const Color(0xFF667EEA),
          brightness: Brightness.dark,
        ),
        useMaterial3: true,
        fontFamily: 'Roboto',
      ),
      home: const HomeScreen(),
    );
  }
}
