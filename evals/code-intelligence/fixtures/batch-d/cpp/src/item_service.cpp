#include "../include/item_service.hpp"

namespace demo {
Item ItemService::lookup(const std::string &id) const { return Item{id}; }
Item ItemService::find(const std::string &id) const { return Item{id}; }
Item ItemService::find(long id) const { return Item{std::to_string(id)}; }

Item load_item(const ItemService &service, const std::string &id) {
  return service.lookup(id);
}

Item ambiguous(const std::string &id) { return find(id); }
}
