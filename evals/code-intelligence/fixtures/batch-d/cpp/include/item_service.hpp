#pragma once

#include <string>

namespace demo {
struct Item {
  std::string id;
};

template <typename ItemType> class ItemLoader {
 public:
  virtual ItemType find(const std::string &id) const = 0;
};

class ItemService final : public ItemLoader<Item> {
 public:
  ItemService() = default;
  Item lookup(const std::string &id) const;
  Item find(const std::string &id) const override;
  Item find(long id) const;
};
}
