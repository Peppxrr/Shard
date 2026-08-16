// Small shared helpers for the game detection subsystem (pure, testable).
#pragma once

#include <algorithm>
#include <cctype>
#include <string>
#include <vector>

namespace clipforge {

// ASCII-lowercase in place.
inline std::string toLower(std::string s)
{
  std::transform(s.begin(), s.end(), s.begin(), [](unsigned char c) { return (char)std::tolower(c); });
  return s;
}

// Basename of a path (handles both '/' and '\').
inline std::string baseName(const std::string& path)
{
  size_t pos = path.find_last_of("/\\");
  return pos == std::string::npos ? path : path.substr(pos + 1);
}

// Lowercase + normalize separators to '\' + ensure a trailing '\'.
inline std::string normalizePath(const std::string& path)
{
  std::string p = path;
  for (auto& c : p)
    if (c == '/')
      c = '\\';
  p = toLower(std::move(p));
  if (!p.empty() && p.back() != '\\')
    p.push_back('\\');
  return p;
}

// Case-insensitive path containment (a path is inside a normalized dir).
inline bool pathUnder(const std::string& lowerPath, const std::string& normalizedDir)
{
  if (normalizedDir.empty() || lowerPath.size() < normalizedDir.size())
    return false;
  return lowerPath.compare(0, normalizedDir.size(), normalizedDir) == 0;
}

// "Elden Ring" -> "elden-ring"; stable ASCII slug for ids.
inline std::string slugify(const std::string& s)
{
  std::string out;
  out.reserve(s.size());
  bool prevDash = false;
  for (unsigned char c : s) {
    if (std::isalnum(c)) {
      out.push_back((char)std::tolower(c));
      prevDash = false;
    } else if (!prevDash && !out.empty()) {
      out.push_back('-');
      prevDash = true;
    }
  }
  while (!out.empty() && out.back() == '-')
    out.pop_back();
  return out;
}

// Trim ASCII whitespace.
inline std::string trim(const std::string& s)
{
  size_t b = 0, e = s.size();
  while (b < e && std::isspace((unsigned char)s[b]))
    b++;
  while (e > b && std::isspace((unsigned char)s[e - 1]))
    e--;
  return s.substr(b, e - b);
}

// Lowercased, whitespace-collapsed name used for cross-layer identity merge.
inline std::string normalizedGameName(const std::string& name)
{
  std::string out;
  out.reserve(name.size());
  bool prevSpace = false;
  for (unsigned char c : name) {
    if (std::isspace(c)) {
      if (!prevSpace && !out.empty())
        out.push_back(' ');
      prevSpace = true;
    } else {
      out.push_back((char)std::tolower(c));
      prevSpace = false;
    }
  }
  while (!out.empty() && out.back() == ' ')
    out.pop_back();
  return out;
}

// Split a string on any of the given delimiters.
inline std::vector<std::string> split(const std::string& s, const std::string& delims)
{
  std::vector<std::string> out;
  size_t start = 0;
  while (start <= s.size()) {
    size_t end = s.find_first_of(delims, start);
    if (end == std::string::npos)
      end = s.size();
    if (end > start)
      out.push_back(s.substr(start, end - start));
    start = end + 1;
  }
  return out;
}

} // namespace clipforge
