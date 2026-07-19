#include "../include/item.h"

int main(void) {
  Item item = item_find("one");
  return item.id == 0;
}
