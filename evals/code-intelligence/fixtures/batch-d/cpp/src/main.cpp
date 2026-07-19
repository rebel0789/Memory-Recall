#include "../include/item_service.hpp"

int main() {
  demo::ItemService service;
  return service.find("one").id.empty();
}
